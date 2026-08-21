import type { RedditDiscoveryCandidate } from "@/lib/domain/types";
import { harshmaurCandidate } from "@/lib/providers/reddit-harshmaur.server";

export const REDDIT_MONITOR_ACTOR_ID = "harshmaur/reddit-search-scraper";

export type RedditMonitorActorInput = {
  searchTerms: string[];
  searchPosts: true;
  searchComments: true;
  searchCommunities: false;
  searchSort: "new";
  searchTime: "all";
  postedAfter: string;
  postedBefore: string;
  commentedAfter: string;
  commentedBefore: string;
  maxPostsCount: number;
  maxCommentsCount: number;
  crawlCommentsPerPost: false;
  includeNSFW: false;
  sentimentAnalysis: false;
  proxy: { useApifyProxy: true; apifyProxyGroups: ["RESIDENTIAL"] };
};

export type RedditMonitorFetchResult = {
  actorRunId: string;
  candidates: RedditDiscoveryCandidate[];
  fetched: number;
  rejected: number;
};

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(parsed, max)) : fallback;
}

export function normalizeWatchTerms(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const value of values) {
    const term = value.replace(/\s+/gu, " ").trim().slice(0, 120);
    const key = term.toLocaleLowerCase("en-US");
    if (term.length < 2 || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= 40) break;
  }
  return terms;
}

export function buildRedditMonitorActorInput(input: {
  watchTerms: readonly string[];
  from: Date;
  to: Date;
  environment?: NodeJS.ProcessEnv;
}): RedditMonitorActorInput {
  const environment = input.environment ?? process.env;
  const searchTerms = normalizeWatchTerms(input.watchTerms);
  if (searchTerms.length === 0) throw new Error("At least one active Reddit watch term is required.");
  if (!Number.isFinite(input.from.getTime()) || !Number.isFinite(input.to.getTime())) {
    throw new Error("Reddit monitoring requires a valid timestamp window.");
  }
  if (input.to.getTime() < input.from.getTime()) {
    throw new Error("Reddit monitoring window end cannot precede its start.");
  }
  return {
    searchTerms,
    searchPosts: true,
    searchComments: true,
    searchCommunities: false,
    searchSort: "new",
    searchTime: "all",
    postedAfter: input.from.toISOString(),
    postedBefore: input.to.toISOString(),
    commentedAfter: input.from.toISOString(),
    commentedBefore: input.to.toISOString(),
    maxPostsCount: boundedInteger(environment.REDDIT_MONITOR_MAX_POSTS_PER_TERM, 10, 1, 100),
    maxCommentsCount: boundedInteger(environment.REDDIT_MONITOR_MAX_COMMENTS_PER_TERM, 10, 1, 100),
    crawlCommentsPerPost: false,
    includeNSFW: false,
    sentimentAnalysis: false,
    proxy: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
  };
}

function stringValue(value: unknown, max = 20_000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function candidateFromActorItem(
  value: unknown,
  since: string,
  until: string,
): RedditDiscoveryCandidate | null {
  const parsed = harshmaurCandidate(value, {
    since,
    until,
    lanes: ["brand_competitor_mentions"],
  }).candidate;
  if (!parsed) return null;
  return {
    ...parsed,
    // Apify Reddit access is explicitly labeled as test data in the MVP UI;
    // the candidate otherwise keeps the exact provider identity and normalized
    // fields used by the existing discovery pipeline.
    sourceMode: "apify-test",
    provenance: {
      ...parsed.provenance,
      metadata: {
        ...(parsed.provenance.metadata ?? {}),
        testOnly: true,
        monitorWatchTerm: parsed.matchedQuery ?? null,
      },
    },
  };
}

function mergeCandidates(candidates: RedditDiscoveryCandidate[]): RedditDiscoveryCandidate[] {
  const byId = new Map<string, RedditDiscoveryCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.provider}:${candidate.externalId}`;
    const existing = byId.get(key);
    if (!existing) {
      byId.set(key, candidate);
      continue;
    }
    const matchedQueries = normalizeWatchTerms([
      ...existing.matchedQueries,
      ...candidate.matchedQueries,
    ]);
    byId.set(key, {
      ...existing,
      matchedQuery: matchedQueries[0],
      matchedQueries,
      provenance: {
        ...existing.provenance,
        observedAt: candidate.provenance.observedAt,
        metadata: {
          ...(existing.provenance.metadata ?? {}),
          matchedWatchTermCount: matchedQueries.length,
        },
      },
    });
  }
  return [...byId.values()];
}

async function responseJson(response: Response, maxBytes = 8_000_000): Promise<unknown> {
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw new Error("Apify response exceeded the monitoring size limit.");
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error("Apify returned invalid JSON to the monitoring provider.");
  }
}

function dataObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const object = value as Record<string, unknown>;
  return object.data && typeof object.data === "object" && !Array.isArray(object.data)
    ? object.data as Record<string, unknown>
    : object;
}

export async function fetchRedditMonitorCandidates(input: {
  watchTerms: readonly string[];
  from: Date;
  to: Date;
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<RedditMonitorFetchResult> {
  const environment = input.environment ?? process.env;
  const token = environment.APIFY_TOKEN?.trim();
  if (!token) throw new Error("APIFY_TOKEN is required for Reddit monitoring.");
  const actorId = (environment.REDDIT_MONITOR_ACTOR_ID?.trim() || REDDIT_MONITOR_ACTOR_ID)
    .replace("/", "~");
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const actorInput = buildRedditMonitorActorInput({
    watchTerms: input.watchTerms,
    from: input.from,
    to: input.to,
    environment,
  });
  const startUrl = new URL(`/v2/acts/${encodeURIComponent(actorId)}/runs`, "https://api.apify.com");
  startUrl.searchParams.set("waitForFinish", "60");
  const startResponse = await fetchImpl(startUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(actorInput),
    signal: AbortSignal.timeout(90_000),
  });
  if (!startResponse.ok) {
    throw new Error(`Reddit monitoring Actor could not start (HTTP ${startResponse.status}).`);
  }
  let run = dataObject(await responseJson(startResponse));
  const actorRunId = stringValue(run.id, 160);
  if (!actorRunId) throw new Error("Reddit monitoring Actor returned no run ID.");
  const deadline = Date.now() + boundedInteger(environment.REDDIT_MONITOR_TIMEOUT_SECONDS, 600, 60, 1_200) * 1_000;
  while (!["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(stringValue(run.status, 40))) {
    if (Date.now() >= deadline) throw new Error("Reddit monitoring Actor timed out.");
    const statusUrl = new URL(`/v2/actor-runs/${encodeURIComponent(actorRunId)}`, "https://api.apify.com");
    statusUrl.searchParams.set("waitForFinish", "60");
    const response = await fetchImpl(statusUrl, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(70_000),
    });
    if (!response.ok) throw new Error(`Reddit monitoring Actor status failed (HTTP ${response.status}).`);
    run = dataObject(await responseJson(response));
  }
  if (stringValue(run.status, 40) !== "SUCCEEDED") {
    throw new Error(`Reddit monitoring Actor ended with status ${stringValue(run.status, 40) || "unknown"}.`);
  }
  const datasetId = stringValue(run.defaultDatasetId, 160);
  if (!datasetId) throw new Error("Reddit monitoring Actor completed without a dataset.");
  const datasetUrl = new URL(`/v2/datasets/${encodeURIComponent(datasetId)}/items`, "https://api.apify.com");
  datasetUrl.searchParams.set("clean", "true");
  datasetUrl.searchParams.set("format", "json");
  datasetUrl.searchParams.set("limit", "1000");
  const datasetResponse = await fetchImpl(datasetUrl, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(90_000),
  });
  if (!datasetResponse.ok) {
    throw new Error(`Reddit monitoring dataset failed (HTTP ${datasetResponse.status}).`);
  }
  const rawItems = await responseJson(datasetResponse);
  if (!Array.isArray(rawItems)) throw new Error("Reddit monitoring dataset was not an array.");
  const parsed = rawItems
    .map((value) => candidateFromActorItem(value, input.from.toISOString(), input.to.toISOString()))
    .filter((value): value is RedditDiscoveryCandidate => Boolean(value));
  return {
    actorRunId,
    candidates: mergeCandidates(parsed),
    fetched: rawItems.length,
    rejected: rawItems.length - parsed.length,
  };
}
