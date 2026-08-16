import type {
  EnrichedRedditConversation,
  RedditContextMessage,
  RedditDiscoveryCandidate,
  RedditSearchLane,
} from "@/lib/domain/types";
import type {
  RedditDiscoveryDiagnostics,
  RedditDiscoveryResponse,
  RedditEnrichmentRequest,
  RedditEnrichmentResponse,
  RedditProvider,
  RedditSearchPlanEntry,
  RedditSearchRequest,
} from "@/lib/providers/contracts";
import { contentFingerprint } from "@/lib/intelligence/opportunity-ranking";
import { naturalSearchTerms } from "@/lib/providers/reddit-natural-queries";

/**
 * Adapter for the `harshmaur/reddit-scraper` Apify actor.
 *
 * This is a separate provider rather than a different `APIFY_REDDIT_ACTOR_ID`
 * because the input and output schemas differ from Trudax in kind, not degree:
 * Harshmaur takes a list of plain `searchTerms` and searches posts and comments
 * directly, returning records with their own field names and its own notion of
 * which term produced them. Both providers still emit the same normalized
 * RedditDiscoveryCandidate, so everything downstream is unchanged.
 *
 * Retrieval philosophy: search broadly on short natural phrases and let
 * DemandSift's AI classify. Reddit search is not an intent classifier.
 */

export interface HarshmaurActorInput {
  searchTerms: string[];
  searchPosts: boolean;
  searchComments: boolean;
  searchCommunities: boolean;
  searchSort: "new";
  searchTime: "week";
  /** Server-side cutoffs; our own timestamp check still runs afterwards. */
  postedAfter: string;
  commentedAfter: string;
  /** Discovery never crawls threads; enrichment is a separate, later pass. */
  crawlCommentsPerPost: false;
  includeNSFW: false;
  /**
   * Global caps across all search terms, not per term. The schema states
   * "total across all inputs", so these bound the whole run.
   */
  maxPostsCount: number;
  maxCommentsCount: number;
  maxCommentsPerPost: 0;
  maxCommunitiesCount: 0;
}

export interface HarshmaurRunSummary {
  /** Records returned per search term, for per-term yield reporting. */
  rawByTerm: Record<string, number>;
  rawRecords: number;
  posts: number;
  comments: number;
  droppedByReason: Record<string, number>;
}

/**
 * Normalize an actor reference to Apify's path form. Mirrors the Trudax
 * normalizer: `username/actor` becomes `username~actor`, and anything else is
 * rejected rather than silently requested.
 */
export function harshmaurActorId(value: string): string {
  const normalized = value.trim().replace("/", "~");
  if (!/^(?:[A-Za-z0-9_-]{5,80}|[A-Za-z0-9_-]{1,80}~[A-Za-z0-9_-]{1,100})$/.test(normalized)) {
    throw new Error("HARSHMAUR_REDDIT_ACTOR_ID is invalid.");
  }
  return normalized;
}

/** Exact previous-7-day bounds, used for both actor input and local checks. */
export function sevenDayWindow(now: Date = new Date()): { since: string; until: string } {
  const until = new Date(now.getTime());
  const since = new Date(now.getTime() - 7 * 86_400_000);
  return { since: since.toISOString(), until: until.toISOString() };
}

/**
 * Split a global acquisition target between posts and comments.
 *
 * `maxPostsCount` and `maxCommentsCount` are documented as totals across all
 * search results, not per-term quotas, so the target is divided by kind rather
 * than by the number of terms. An earlier version divided by term count, which
 * would have under-requested by roughly an order of magnitude and made a
 * Trudax comparison meaningless.
 *
 * Per-term yield is still measurable: every record carries its own
 * `searchTerm`, so attribution comes from the returned data rather than from
 * separate caps.
 */
export function harshmaurAcquisitionBudget(
  targetTotal: number,
): { maxPostsCount: number; maxCommentsCount: number } {
  const total = Math.max(2, Math.trunc(targetTotal));
  const posts = Math.max(1, Math.floor(total / 2));
  return { maxPostsCount: posts, maxCommentsCount: Math.max(1, total - posts) };
}

export function buildHarshmaurInput(
  request: RedditSearchRequest,
  options: { targetTotal: number; now?: Date; maxTerms?: number },
): HarshmaurActorInput {
  const { since } = sevenDayWindow(options.now);
  const windowStart = request.since && Number.isFinite(Date.parse(request.since))
    ? request.since
    : since;

  const searchTerms = naturalSearchTerms(request, { maxTerms: options.maxTerms ?? 12 });
  const { maxPostsCount, maxCommentsCount } = harshmaurAcquisitionBudget(options.targetTotal);

  return {
    searchTerms,
    searchPosts: true,
    searchComments: true,
    // Community records are directory entries, not conversations.
    searchCommunities: false,
    // "new" keeps the window honest; "relevance" re-ranks across all time and
    // would return records from outside the seven days we asked for.
    searchSort: "new",
    searchTime: "week",
    postedAfter: windowStart,
    commentedAfter: windowStart,
    crawlCommentsPerPost: false,
    includeNSFW: false,
    maxPostsCount,
    maxCommentsCount,
    maxCommentsPerPost: 0,
    maxCommunitiesCount: 0,
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function count(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Harshmaur emits epoch seconds for some record types.
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function subredditName(value: unknown): string | undefined {
  const raw = text(value);
  return raw ? raw.replace(/^\/?r\//i, "") : undefined;
}

function permalinkFor(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://www.reddit.com${raw.startsWith("/") ? "" : "/"}${raw}`;
}

export interface HarshmaurParseOptions {
  /** Records older than this are discarded regardless of actor filtering. */
  since: string;
  until?: string;
  lanes?: RedditSearchLane[];
}

/**
 * Normalize one Harshmaur record.
 *
 * The actor's own `searchTerm` is preserved verbatim as the matched query so
 * per-term yield can be reported honestly; it is never reconstructed by
 * guessing which of our phrases the record resembles.
 */
export function harshmaurCandidate(
  value: unknown,
  options: HarshmaurParseOptions,
): { candidate: RedditDiscoveryCandidate | null; reason?: string } {
  if (!value || typeof value !== "object") return { candidate: null, reason: "invalid_record" };
  const row = value as Record<string, unknown>;

  const kindRaw = (text(row.type) ?? text(row.dataType) ?? "").toLowerCase();
  const looksLikeComment = kindRaw.includes("comment") || Boolean(row.postId ?? row.parentId);
  const kind: RedditDiscoveryCandidate["kind"] = looksLikeComment ? "comment" : "post";

  const externalId = text(row.id) ?? text(row.commentId) ?? text(row.postId);
  if (!externalId) return { candidate: null, reason: "invalid_record" };

  const body = text(row.body) ?? text(row.text) ?? text(row.selftext) ?? "";
  const title = text(row.title);
  if (!body && !title) return { candidate: null, reason: "invalid_record" };

  const subreddit = subredditName(
    row.subredditName ?? row.subreddit ?? row.communityName ?? row.community,
  );
  if (!subreddit) return { candidate: null, reason: "invalid_record" };

  // Harshmaur names the comment timestamp differently from the post one, so a
  // parser that only looked for `createdAt` rejected every real comment-search
  // result as missing_timestamp.
  const createdAt = isoTimestamp(
    kind === "comment"
      ? row.commentCreatedAt ?? row.createdAt ?? row.created ?? row.createdUtc ?? row.timestamp
      : row.createdAt ?? row.postCreatedAt ?? row.created ?? row.createdUtc ?? row.timestamp,
  );
  if (!createdAt) return { candidate: null, reason: "missing_timestamp" };

  // Second guard: never trust the actor's own date filtering.
  const created = Date.parse(createdAt);
  if (created < Date.parse(options.since)) return { candidate: null, reason: "outside_window" };
  if (options.until && created > Date.parse(options.until) + 60_000) {
    return { candidate: null, reason: "outside_window" };
  }

  // Comments carry `url` for the comment itself and `postUrl` for its parent
  // post. Preferring postUrl for a comment would point every piece of comment
  // evidence at the thread instead of the exact statement we qualified on.
  const permalink = permalinkFor(
    kind === "comment"
      ? row.url ?? row.permalink ?? row.postUrl ?? row.link
      : row.postUrl ?? row.url ?? row.permalink ?? row.link,
  );
  if (!permalink) return { candidate: null, reason: "invalid_url" };

  const author = text(row.authorName ?? row.author ?? row.username);
  if (author && /^(automoderator|\[deleted\])$/i.test(author)) {
    return { candidate: null, reason: "bot_author" };
  }

  // Attribution comes from the actor, verbatim.
  const matchedQuery = text(row.searchTerm ?? row.searchQuery ?? row.query);

  return {
    candidate: {
      provider: "apify-harshmaur-reddit",
      sourceMode: "live",
      externalId,
      kind,
      // `parentId` is the immediate parent, `postId` the thread root. Using
      // postId first flattened nested replies onto the post.
      parentExternalId:
        kind === "comment" ? text(row.parentId ?? row.postId) : undefined,
      subreddit,
      title,
      body: body || title || "",
      author,
      permalink,
      createdAt,
      metrics: {
        score: count(row.score ?? row.upVotes ?? row.upvotes),
        // `commentsCount` is the field the real post output uses.
        comments: count(
          row.commentsCount ?? row.numberOfComments ?? row.commentCount ?? row.numComments,
        ),
      },
      matchedQuery,
      matchedQueries: matchedQuery ? [matchedQuery] : [],
      discoveryLanes: options.lanes ?? [],
      provenance: {
        id: `reddit_harshmaur_${contentFingerprint(externalId)}`,
        kind: "reddit",
        provider: "apify-harshmaur-reddit",
        providerExternalId: externalId,
        url: permalink,
        title,
        excerpt: (body || title || "").slice(0, 280),
        contentHash: contentFingerprint(`${title ?? ""}\n${body}`),
        observedAt: new Date().toISOString(),
        isMock: false,
        metadata: {
          acquisitionMethod: "web-scraping",
          // The actor's own attribution, kept for per-term yield reporting.
          searchTerm: matchedQuery ?? null,
        },
      },
    },
    reason: undefined,
  };
}

/** Normalize a full dataset, deduplicating by external id. */
export function parseHarshmaurDataset(
  payload: readonly unknown[],
  options: HarshmaurParseOptions,
): { candidates: RedditDiscoveryCandidate[]; summary: HarshmaurRunSummary } {
  const seen = new Map<string, RedditDiscoveryCandidate>();
  const summary: HarshmaurRunSummary = {
    rawByTerm: {},
    rawRecords: payload.length,
    posts: 0,
    comments: 0,
    droppedByReason: {},
  };

  for (const value of payload) {
    const term =
      (value && typeof value === "object"
        ? text((value as Record<string, unknown>).searchTerm)
        : undefined) ?? "<unattributed>";
    summary.rawByTerm[term] = (summary.rawByTerm[term] ?? 0) + 1;

    const { candidate, reason } = harshmaurCandidate(value, options);
    if (!candidate) {
      const key = reason ?? "unknown";
      summary.droppedByReason[key] = (summary.droppedByReason[key] ?? 0) + 1;
      continue;
    }

    const existing = seen.get(candidate.externalId);
    if (existing) {
      // The same record can arrive from several terms; keep every attribution.
      for (const query of candidate.matchedQueries) {
        if (!existing.matchedQueries.includes(query)) existing.matchedQueries.push(query);
      }
      continue;
    }
    seen.set(candidate.externalId, candidate);
    if (candidate.kind === "comment") summary.comments += 1;
    else summary.posts += 1;
  }

  return { candidates: [...seen.values()], summary };
}


/* ------------------------------------------------------------------ *
 * Provider
 * ------------------------------------------------------------------ */

/**
 * Executes the Harshmaur actor and returns candidates through the shared
 * contract, so the scan workflow cannot tell which actor produced them.
 *
 * Discovery only: `crawlCommentsPerPost` stays false and enrichment falls back
 * to the discovery record. Thread enrichment remains Trudax's job until the A/B
 * selects a winner, which keeps the comparison about retrieval quality rather
 * than two half-built pipelines.
 */
export class HarshmaurRedditProvider implements RedditProvider {
  readonly name = "apify-harshmaur-reddit";
  readonly sourceMode = "live" as const;
  /**
   * Discovery only. Harshmaur runs with crawlCommentsPerPost=false, so it has
   * no thread context to give. Until selective enrichment exists (startUrls +
   * crawlCommentsPerPost=true + bounded maxCommentsPerPost), this provider is
   * valid for a retrieval A/B but must not be compared on lead or reply
   * quality against Trudax, which does perform real thread enrichment.
   */
  readonly supportsThreadEnrichment = false;

  private readonly actorId: string;
  private readonly token: string;
  private readonly maximumItems: number;
  private readonly maxTerms: number;
  private readonly timeoutMs: number;
  private readonly maxChargeUsd: number;
  private readonly fetchImpl: typeof fetch;

  constructor(input: {
    actorId?: string;
    token: string;
    maximumItems?: number;
    maxTerms?: number;
    timeoutMs?: number;
    maxChargeUsd?: number;
    fetchImpl?: typeof fetch;
  }) {
    // Apify's API path takes an actor id or `username~actor-name`; a slash
    // would be percent-encoded and resolve to nothing.
    this.actorId = harshmaurActorId(input.actorId?.trim() || "harshmaur~reddit-scraper");
    this.token = input.token;
    this.maximumItems = Math.max(1, Math.min(400, Math.trunc(input.maximumItems ?? 250)));
    this.maxTerms = Math.max(1, Math.min(25, Math.trunc(input.maxTerms ?? 12)));
    this.timeoutMs = Math.max(20_000, Math.min(600_000, Math.trunc(input.timeoutMs ?? 360_000)));
    this.maxChargeUsd = Math.max(0.05, Math.min(5, input.maxChargeUsd ?? 1));
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  /**
   * Start the actor asynchronously, poll to a terminal state, then page the
   * dataset.
   *
   * `/run-sync` is deliberately not used: it returns the actor's OUTPUT record
   * rather than run metadata, so `defaultDatasetId` is absent, and holding a
   * non-idempotent POST open makes a transient gateway 502 ambiguous — a retry
   * could start and bill a second run. Once the run id exists, all waiting and
   * reading happens through retry-safe GETs. This mirrors the pattern already
   * proven in the Trudax provider.
   */
  private async runActor(
    actorInput: HarshmaurActorInput,
    platformMaxItems: number,
  ): Promise<unknown[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = {
      accept: "application/json",
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
    };

    const readJson = async (response: Response): Promise<unknown> => {
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`Harshmaur request failed with HTTP ${response.status}.`);
      }
      try {
        return raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error("The Harshmaur actor returned invalid JSON.");
      }
    };

    const safeGet = async (endpoint: URL): Promise<Response> => {
      const retryable = new Set([408, 425, 429, 500, 502, 503, 504]);
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await this.fetchImpl(endpoint, {
            headers,
            signal: controller.signal,
          });
          if (!retryable.has(response.status)) return response;
          await response.text().catch(() => "");
        } catch (error) {
          lastError = error;
          if (controller.signal.aborted || attempt === 2) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** attempt, 2_000)));
      }
      throw lastError ?? new Error("Harshmaur GET request failed.");
    };

    const runData = (payload: unknown): Record<string, unknown> => {
      const data = (payload as { data?: unknown } | null)?.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("The Harshmaur actor returned invalid run metadata.");
      }
      return data as Record<string, unknown>;
    };

    const str = (value: unknown): string =>
      typeof value === "string" ? value.slice(0, 120) : "";

    try {
      const startEndpoint = new URL(
        `/v2/actors/${encodeURIComponent(this.actorId)}/runs`,
        "https://api.apify.com",
      );
      startEndpoint.searchParams.set("waitForFinish", "0");
      startEndpoint.searchParams.set("timeout", String(Math.ceil(this.timeoutMs / 1000)));
      // Platform-level guards. These bound cost and dataset size; they do not
      // replace the actor's own maxPostsCount/maxCommentsCount fields.
      startEndpoint.searchParams.set("maxItems", String(platformMaxItems));
      startEndpoint.searchParams.set("maxTotalChargeUsd", this.maxChargeUsd.toFixed(2));

      const startResponse = await this.fetchImpl(startEndpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(actorInput),
        signal: controller.signal,
      });
      const started = runData(await readJson(startResponse));
      const runId = str(started.id);
      let status = str(started.status).toUpperCase();
      let datasetId = str(started.defaultDatasetId);
      let statusMessage = str(started.statusMessage);
      if (!runId || !status) {
        throw new Error("The Harshmaur actor returned incomplete run metadata.");
      }

      const terminal = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);
      while (!terminal.has(status)) {
        const statusEndpoint = new URL(
          `/v2/actor-runs/${encodeURIComponent(runId)}`,
          "https://api.apify.com",
        );
        statusEndpoint.searchParams.set("waitForFinish", "60");
        const current = runData(await readJson(await safeGet(statusEndpoint)));
        status = str(current.status).toUpperCase();
        statusMessage = str(current.statusMessage);
        datasetId = str(current.defaultDatasetId) || datasetId;
        if (!status) throw new Error("The Harshmaur actor returned incomplete run status.");
      }

      // A timed-out run that still produced records is usable; discarding it
      // would waste a paid run.
      const usablePartial = status === "TIMED-OUT" && Boolean(datasetId);
      if (status !== "SUCCEEDED" && !usablePartial) {
        throw new Error(
          `The Harshmaur run ended with status ${status}${statusMessage ? `: ${statusMessage}` : ""}.`,
        );
      }
      if (!datasetId) throw new Error("The Harshmaur run completed without a dataset.");

      const pageSize = 100;
      const payload: unknown[] = [];
      for (let offset = 0; offset < platformMaxItems; offset += pageSize) {
        const limit = Math.min(pageSize, platformMaxItems - offset);
        const datasetEndpoint = new URL(
          `/v2/datasets/${encodeURIComponent(datasetId)}/items`,
          "https://api.apify.com",
        );
        datasetEndpoint.searchParams.set("clean", "true");
        datasetEndpoint.searchParams.set("format", "json");
        datasetEndpoint.searchParams.set("limit", String(limit));
        datasetEndpoint.searchParams.set("offset", String(offset));

        const page = await readJson(await safeGet(datasetEndpoint));
        if (!Array.isArray(page)) {
          throw new Error("The Harshmaur actor returned an invalid dataset.");
        }
        payload.push(...page);
        if (page.length < limit) break;
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  async discover(request: RedditSearchRequest): Promise<RedditDiscoveryResponse> {
    const targetTotal = Math.min(this.maximumItems, Math.max(40, request.limit));
    const actorInput = buildHarshmaurInput(request, {
      targetTotal,
      maxTerms: this.maxTerms,
    });
    if (actorInput.searchTerms.length === 0) {
      throw new Error("The company context did not produce any usable Reddit search terms.");
    }

    // Headroom over the target so per-term rounding cannot silently truncate,
    // while still capping spend at the platform level.
    const platformMaxItems = Math.min(1_000, Math.ceil(targetTotal * 1.3));
    const payload = await this.runActor(actorInput, platformMaxItems);
    const window = sevenDayWindow();
    const since = request.since && Number.isFinite(Date.parse(request.since))
      ? request.since
      : window.since;
    const { candidates, summary } = parseHarshmaurDataset(payload, { since });

    // Each search term is its own plan entry, so per-term yield stays
    // attributable all the way through the report.
    const searchPlan: RedditSearchPlanEntry[] = actorInput.searchTerms.map((term) => ({
      lane: "category_recommendation" as RedditSearchLane,
      query: term,
      seed: term,
    }));

    const rejected: Record<string, number> = {
      invalid_record: 0,
      invalid_url: 0,
      query_mismatch: 0,
      bot_author: 0,
      deleted: 0,
      nsfw: 0,
      missing_timestamp: 0,
      outside_window: 0,
    };
    for (const [reason, value] of Object.entries(summary.droppedByReason)) {
      if (reason in rejected) rejected[reason] += value;
      else rejected.invalid_record += value;
    }

    return {
      candidates,
      searchPlan,
      sourceMode: this.sourceMode,
      diagnostics: {
        queryCount: actorInput.searchTerms.length,
        fetchedCandidates: summary.rawRecords,
        normalizedCandidates: candidates.length,
        verifiedRecentCandidates: candidates.length,
        rejectedByReason: rejected as RedditDiscoveryDiagnostics["rejectedByReason"],
        laneQueryCounts: { category_recommendation: actorInput.searchTerms.length },
      },
    };
  }

  /**
   * Discovery-only enrichment. The record is passed through with its own text
   * as context rather than fabricating thread structure the actor never
   * fetched, so downstream coverage checks see the truth.
   */
  async enrich(request: RedditEnrichmentRequest): Promise<RedditEnrichmentResponse> {
    const conversations: EnrichedRedditConversation[] = request.candidates.map((candidate) => {
      const matched: RedditContextMessage = {
        externalId: candidate.externalId,
        kind: candidate.kind,
        author: candidate.author,
        body: candidate.body,
        parentExternalId: candidate.parentExternalId,
        createdAt: candidate.createdAt,
      };
      return {
        ...candidate,
        structuredContext: {
          originalPost: candidate.kind === "post" ? matched : undefined,
          matched,
          parentChain: [],
          replies: [],
          surroundingComments: [],
        },
        threadContext: undefined,
        enriched: false,
        contextConfidence: "discovery_only",
      } as EnrichedRedditConversation;
    });

    return {
      conversations,
      sourceMode: this.sourceMode,
      diagnostics: {
        requested: request.candidates.length,
        enriched: 0,
        failed: 0,
        fallbackUsed: conversations.length,
      },
    };
  }
}
