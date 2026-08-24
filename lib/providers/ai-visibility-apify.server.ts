import { ApifyTransientError, APIFY_RETRYABLE_RUN_STATUSES, isApifyRetryableHttpStatus } from "@/lib/providers/apify-retry";
import type { AiVisibilityAiProvider, AiVisibilityCitation } from "@/lib/server/contracts";

/**
 * AI Visibility Tracking's own, self-contained Apify actor caller.
 *
 * This is a deliberate near-duplicate of the request/poll/dataset-fetch
 * shape used by lib/providers/reddit.server.ts's ApifyRedditTestProvider,
 * not a shared abstraction over it -- AI Visibility Tracking is a sidecar
 * kept isolated from the Reddit discovery/monitoring pipelines (see
 * lib/server/ai-visibility-workflow.ts), so it does not import from or
 * couple to reddit.server.ts. Only the small, generic retry-classification
 * helpers in apify-retry.ts (already provider-agnostic) are reused.
 */

export type RawVisibilityAnswer = {
  question: string;
  answerText: string;
  citations: AiVisibilityCitation[];
  model: string | null;
};

export type VisibilityActorRunResult = {
  provider: AiVisibilityAiProvider;
  actorRunId: string | null;
  answers: RawVisibilityAnswer[];
  /** Questions the actor could not answer, so the caller can still store a record for them. */
  failedQuestions: string[];
  /**
   * Set only when the whole Actor run never produced a usable result (the
   * run never started, or ended in a non-retryable failure) -- the exact
   * reason, including any Apify-supplied remediation link, so the AI
   * visibility results view can tell the user what actually happened
   * instead of a bare "no answer". Null on a normal, fully successful run.
   */
  error: string | null;
};

/**
 * How long a batched, 3-question Actor run is given before Apify itself
 * kills it (the "timeout" query param on the start call, below) and before
 * this client gives up waiting. Observed real runs against the live
 * account: successful chatgpt-search-scraper runs already took up to ~4
 * minutes (3m58s, 3m16s) for 3 live AI-answered search queries, and the
 * previous 240_000ms (4 min) value here caused Apify to kill some runs
 * with status TIMED-OUT right at that boundary -- not a 403, not a
 * credentials/approval problem, just not enough headroom for what this
 * Actor actually does. Doubled for real margin.
 */
const ACTOR_TIMEOUT_MS = 480_000;

function apifyActorId(value: string): string {
  const normalized = value.trim().replace("/", "~");
  if (!/^(?:[A-Za-z0-9_-]{5,80}|[A-Za-z0-9_-]{1,80}~[A-Za-z0-9_-]{1,100})$/.test(normalized)) {
    throw new Error(`Invalid Apify actor id: ${value}`);
  }
  return normalized;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Turns a non-2xx Apify response body into an actionable message. Apify
 * returns structured JSON errors (`{error: {type, message, data}}`), not
 * just an HTTP status -- and for the specific, well-documented case of a
 * full-permission Actor (which these 3 official search-scraper Actors are)
 * never having been run from this account before, the body includes an
 * `approvalUrl` that a human must open in Apify Console: approval is
 * deliberately blocked from the API itself, so no code change or retry can
 * fix this, only a one-time click by whoever owns the Apify account. See
 * https://apify.com/change-log/full-permission-actors-approval.
 */
function describeApifyError(provider: string, status: number, raw: string): string {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const errorObject =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).error
      : null;
  if (errorObject && typeof errorObject === "object" && !Array.isArray(errorObject)) {
    const fields = errorObject as Record<string, unknown>;
    const type = stringField(fields.type);
    const message = stringField(fields.message);
    const data = fields.data;
    const approvalUrl =
      data && typeof data === "object" && !Array.isArray(data)
        ? stringField((data as Record<string, unknown>).approvalUrl)
        : "";
    if (type === "full-permission-actor-not-approved" || approvalUrl) {
      return (
        `The ${provider} visibility Actor has never been approved for API use on this Apify account ` +
        `(HTTP ${status}, full-permission Actor). Apify requires a one-time manual approval in Apify ` +
        `Console before it can be called via the API -- this cannot be done from code or retried away.` +
        (approvalUrl ? ` Approve it at: ${approvalUrl}` : "")
      );
    }
    if (message) {
      return `The ${provider} visibility Actor request failed: ${message} (HTTP ${status}).`;
    }
  }
  return `${provider} visibility Actor request failed with HTTP ${status}.`;
}

/**
 * The 3 "official" Apify search-scraper Actors this feature is specified
 * against (apify/chatgpt-search-scraper, apify/gemini-search-scraper,
 * apify/perplexity-search-scraper). All three are published by the same
 * Apify Store account and share the same input/output shape: a single
 * `queries` field (search prompts, one per line) in, and dataset items with
 * `query`/`text`/`sources` (each `{url, title}`) out. Actor ids are
 * env-overridable so a corrected or renamed slug never requires a code
 * change.
 */
export function defaultActorIdFor(provider: AiVisibilityAiProvider): string {
  switch (provider) {
    case "chatgpt":
      return "apify/chatgpt-search-scraper";
    case "gemini":
      return "apify/gemini-search-scraper";
    case "perplexity":
      return "apify/perplexity-search-scraper";
  }
}

function actorIdFromEnv(provider: AiVisibilityAiProvider, env: NodeJS.ProcessEnv): string {
  const envKey = {
    chatgpt: "APIFY_CHATGPT_VISIBILITY_ACTOR_ID",
    gemini: "APIFY_GEMINI_VISIBILITY_ACTOR_ID",
    perplexity: "APIFY_PERPLEXITY_VISIBILITY_ACTOR_ID",
  }[provider];
  return env[envKey]?.trim() || defaultActorIdFor(provider);
}

/**
 * Runs one Apify search-scraper Actor once, with all 3 questions batched
 * into a single `queries` input (newline-separated) -- one Actor run per
 * provider per scan, exactly as specified, not one run per question.
 */
export async function runVisibilityActor(input: {
  provider: AiVisibilityAiProvider;
  questions: readonly string[];
  token: string;
  actorId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<VisibilityActorRunResult> {
  const actorId = apifyActorId(input.actorId ?? defaultActorIdFor(input.provider));
  const token = input.token.trim();
  if (!token) throw new Error("APIFY_TOKEN is required for AI visibility tracking.");
  const timeoutMs = Math.max(30_000, Math.min(600_000, input.timeoutMs ?? ACTOR_TIMEOUT_MS));
  const fetchImpl = input.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };

  const readJson = async (response: Response, maximumBytes: number): Promise<unknown> => {
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > maximumBytes) {
      throw new Error(`The ${input.provider} visibility Actor response exceeded the size limit.`);
    }
    if (!response.ok) {
      const message = describeApifyError(input.provider, response.status, raw);
      throw isApifyRetryableHttpStatus(response.status) ? new ApifyTransientError(message) : new Error(message);
    }
    try {
      return raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(`The ${input.provider} visibility Actor returned invalid JSON.`);
    }
  };

  const safeGet = async (endpoint: URL): Promise<Response> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetchImpl(endpoint, { method: "GET", headers, signal: controller.signal });
        if (response.ok || !isApifyRetryableHttpStatus(response.status) || attempt === 2) return response;
        await response.text().catch(() => "");
        await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** attempt, 2_000)));
      } catch (error) {
        lastError = error;
        if (controller.signal.aborted || attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** attempt, 2_000)));
      }
    }
    throw lastError instanceof Error
      ? new ApifyTransientError(lastError.message)
      : new ApifyTransientError(`${input.provider} visibility Actor GET request failed.`);
  };

  const runData = (payload: unknown): Record<string, unknown> => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error(`The ${input.provider} visibility Actor returned invalid run metadata.`);
    }
    const data = (payload as { data?: unknown }).data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(`The ${input.provider} visibility Actor returned invalid run metadata.`);
    }
    return data as Record<string, unknown>;
  };

  let runId = "";
  let status = "NOT_STARTED";

  try {
    const startEndpoint = new URL(`/v2/actors/${encodeURIComponent(actorId)}/runs`, "https://api.apify.com");
    startEndpoint.searchParams.set("waitForFinish", "0");
    startEndpoint.searchParams.set("timeout", String(Math.max(60, Math.round(timeoutMs / 1_000))));
    startEndpoint.searchParams.set("maxItems", "50");
    startEndpoint.searchParams.set("maxTotalChargeUsd", "1.00");

    const startResponse = await fetchImpl(startEndpoint, {
      method: "POST",
      headers,
      // The one input field every one of these 3 Actors accepts: search
      // queries, one per line, in a single string -- not an array.
      body: JSON.stringify({ queries: input.questions.join("\n") }),
      signal: controller.signal,
    });
    const started = runData(await readJson(startResponse, 1_000_000));
    runId = stringField(started.id);
    status = stringField(started.status).toUpperCase();
    let statusMessage = stringField(started.statusMessage);
    let datasetId = stringField(started.defaultDatasetId);
    if (!runId || !status) {
      throw new Error(`The ${input.provider} visibility Actor returned incomplete run metadata.`);
    }

    const terminalStatuses = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);
    while (!terminalStatuses.has(status)) {
      const statusEndpoint = new URL(`/v2/actor-runs/${encodeURIComponent(runId)}`, "https://api.apify.com");
      statusEndpoint.searchParams.set("waitForFinish", "60");
      const statusResponse = await safeGet(statusEndpoint);
      const current = runData(await readJson(statusResponse, 1_000_000));
      status = stringField(current.status).toUpperCase();
      statusMessage = stringField(current.statusMessage);
      datasetId = stringField(current.defaultDatasetId) || datasetId;
      if (!status) throw new Error(`The ${input.provider} visibility Actor returned incomplete run status.`);
    }

    // A TIMED-OUT run with a dataset already has real, paid-for answers in
    // it for whatever questions finished before Apify killed the run --
    // discarding those entirely (the previous behavior: treat any non-
    // SUCCEEDED status as a hard failure) throws away work that already
    // happened. Salvage them instead; FAILED/ABORTED, or TIMED-OUT with no
    // dataset at all, still have nothing to salvage and remain hard failures.
    const timedOutWithPartialResults = status === "TIMED-OUT" && Boolean(datasetId);
    if (status !== "SUCCEEDED" && !timedOutWithPartialResults) {
      const message = `The ${input.provider} visibility Actor run ended with status ${status}${statusMessage ? `: ${statusMessage}` : ""}.`;
      throw APIFY_RETRYABLE_RUN_STATUSES.has(status) ? new ApifyTransientError(message) : new Error(message);
    }
    if (!datasetId) throw new ApifyTransientError(`The ${input.provider} visibility Actor run completed without a dataset.`);

    const datasetEndpoint = new URL(`/v2/datasets/${encodeURIComponent(datasetId)}/items`, "https://api.apify.com");
    datasetEndpoint.searchParams.set("clean", "true");
    datasetEndpoint.searchParams.set("format", "json");
    datasetEndpoint.searchParams.set("limit", "50");
    const datasetResponse = await safeGet(datasetEndpoint);
    const items = await readJson(datasetResponse, 5_000_000);
    if (!Array.isArray(items)) throw new Error(`The ${input.provider} visibility Actor returned an invalid dataset.`);

    const answers: RawVisibilityAnswer[] = [];
    const answeredQuestions = new Set<string>();
    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      // Failed-query items land in a separate `errors` dataset for these
      // Actors, but tolerate an inline `error` field defensively too.
      if (typeof item.error === "string" && item.error) continue;
      const question = stringField(item.query) || stringField(item.question);
      // Field names are defensive across the 3 Actors: the documented shape
      // is `text` + `sources`, but a differently-shaped or renamed Actor
      // should degrade gracefully rather than crash the whole scan.
      const answerText = stringField(item.text) || stringField(item.answer) || stringField(item.response);
      if (!question || !answerText) continue;
      const rawSources = Array.isArray(item.sources)
        ? item.sources
        : Array.isArray(item.citations)
          ? item.citations
          : [];
      const citations: AiVisibilityCitation[] = rawSources
        .filter((source): source is Record<string, unknown> => Boolean(source) && typeof source === "object")
        .map((source) => {
          const url = stringField(source.url) || stringField(source.link);
          return { url, title: stringField(source.title) || null, domain: hostnameOf(url) };
        })
        .filter((citation) => citation.url && citation.domain);
      answers.push({
        question,
        answerText,
        citations,
        model: stringField(item.model) || null,
      });
      answeredQuestions.add(question);
    }

    const failedQuestions = input.questions.filter((question) => !answeredQuestions.has(question));
    // Only a soft, informational note -- not thrown -- since the run itself
    // did not fail (or, for a timed-out run, some real answers still came
    // back). Still surfaced as this provider's `error` (see providerErrors
    // in ai-visibility-workflow.ts) so the results view shows *why* fewer
    // than `questions.length` answers exist instead of a bare, unexplained
    // "no answer was returned". A SUCCEEDED run missing some or all
    // answers is a real, observed case, not just a hypothetical: the Actor
    // reports individually-failed queries in a separate `errors` dataset
    // (see the "Failed queries" section of its own docs) that this caller
    // does not fetch, so a query ChatGPT itself couldn't answer surfaces
    // here as "missing", with no lower-level reason available to relay.
    let partialResultNote: string | null = null;
    if (failedQuestions.length > 0) {
      if (timedOutWithPartialResults) {
        partialResultNote = `The ${input.provider} visibility Actor timed out after ${Math.ceil(timeoutMs / 1_000)}s before finishing all ${input.questions.length} questions -- ${answers.length} answer${answers.length === 1 ? "" : "s"} completed before the cutoff, ${failedQuestions.length} did not.`;
      } else if (answers.length === 0) {
        partialResultNote = `The ${input.provider} visibility Actor run completed but did not return an answer for any of the ${input.questions.length} questions (Apify logs individually failed queries separately from this run's main results, so no further reason is available here).`;
      } else {
        partialResultNote = `The ${input.provider} visibility Actor run completed with ${answers.length} of ${input.questions.length} questions answered; ${failedQuestions.length} did not get an answer.`;
      }
    }
    return { provider: input.provider, actorRunId: runId || null, answers, failedQuestions, error: partialResultNote };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ApifyTransientError(
        `The ${input.provider} visibility Actor timed out after ${Math.ceil(timeoutMs / 1_000)}s (status ${status || "UNKNOWN"}, run ${runId || "not-started"}).`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** Runs all 3 provider Actors in parallel -- one Actor run each, as specified. */
export async function runAllVisibilityActors(input: {
  questions: readonly string[];
  token: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<VisibilityActorRunResult[]> {
  const providers: AiVisibilityAiProvider[] = ["chatgpt", "gemini", "perplexity"];
  const env = input.env ?? process.env;
  const settled = await Promise.allSettled(
    providers.map((provider) =>
      runVisibilityActor({
        provider,
        questions: input.questions,
        token: input.token,
        actorId: actorIdFromEnv(provider, env),
        fetchImpl: input.fetchImpl,
      }),
    ),
  );
  return settled.map((outcome, index) => {
    const provider = providers[index];
    if (outcome.status === "fulfilled") return outcome.value;
    // One provider's Actor failing must never sink the other two -- record
    // every question as failed for this provider only, so the scan can
    // still store real answers from the providers that succeeded.
    const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
    console.error(`AI visibility Actor failed for ${provider}: ${message}`);
    return { provider, actorRunId: null, answers: [], failedQuestions: [...input.questions], error: message };
  });
}
