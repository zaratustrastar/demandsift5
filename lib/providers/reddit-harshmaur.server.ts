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
  searchSort: "new" | "relevance" | "top";
  /** Bounded acquisition; the actor stops once this many records exist. */
  maxItems: number;
  /** ISO date bounds; the actor filters server-side where supported. */
  postedAfter?: string;
  commentedAfter?: string;
}

export interface HarshmaurRunSummary {
  /** Records returned per search term, for per-term yield reporting. */
  rawByTerm: Record<string, number>;
  rawRecords: number;
  posts: number;
  comments: number;
  droppedByReason: Record<string, number>;
}

/** Exact previous-7-day bounds, used for both actor input and local checks. */
export function sevenDayWindow(now: Date = new Date()): { since: string; until: string } {
  const until = new Date(now.getTime());
  const since = new Date(now.getTime() - 7 * 86_400_000);
  return { since: since.toISOString(), until: until.toISOString() };
}

export function buildHarshmaurInput(
  request: RedditSearchRequest,
  options: { maxItems: number; now?: Date; maxTerms?: number },
): HarshmaurActorInput {
  const { since } = sevenDayWindow(options.now);
  const windowStart = request.since && Number.isFinite(Date.parse(request.since))
    ? request.since
    : since;

  return {
    searchTerms: naturalSearchTerms(request, { maxTerms: options.maxTerms ?? 12 }),
    searchPosts: true,
    searchComments: true,
    // Community records are directory entries, not conversations.
    searchCommunities: false,
    // "new" keeps the window honest; relevance re-ranks across all time and
    // would quietly return records outside the seven days we asked for.
    searchSort: "new",
    maxItems: Math.max(1, Math.trunc(options.maxItems)),
    postedAfter: windowStart,
    commentedAfter: windowStart,
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

  const subreddit = subredditName(row.subreddit ?? row.community ?? row.subredditName);
  if (!subreddit) return { candidate: null, reason: "invalid_record" };

  const createdAt = isoTimestamp(row.createdAt ?? row.created ?? row.createdUtc ?? row.timestamp);
  if (!createdAt) return { candidate: null, reason: "missing_timestamp" };

  // Second guard: never trust the actor's own date filtering.
  const created = Date.parse(createdAt);
  if (created < Date.parse(options.since)) return { candidate: null, reason: "outside_window" };
  if (options.until && created > Date.parse(options.until) + 60_000) {
    return { candidate: null, reason: "outside_window" };
  }

  const permalink = permalinkFor(row.url ?? row.permalink ?? row.link);
  if (!permalink) return { candidate: null, reason: "invalid_url" };

  const author = text(row.author ?? row.username ?? row.authorName);
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
      parentExternalId: text(row.postId ?? row.parentId),
      subreddit,
      title,
      body: body || title || "",
      author,
      permalink,
      createdAt,
      metrics: {
        score: count(row.score ?? row.upVotes ?? row.upvotes),
        comments: count(row.numberOfComments ?? row.commentCount ?? row.numComments),
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

  private readonly actorId: string;
  private readonly token: string;
  private readonly maximumItems: number;
  private readonly maxTerms: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(input: {
    actorId?: string;
    token: string;
    maximumItems?: number;
    maxTerms?: number;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  }) {
    this.actorId = input.actorId?.trim() || "harshmaur/reddit-scraper";
    this.token = input.token;
    this.maximumItems = Math.max(1, Math.min(400, Math.trunc(input.maximumItems ?? 250)));
    this.maxTerms = Math.max(1, Math.min(25, Math.trunc(input.maxTerms ?? 12)));
    this.timeoutMs = Math.max(20_000, Math.min(600_000, Math.trunc(input.timeoutMs ?? 360_000)));
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  /** Run the actor synchronously and page the whole dataset. */
  private async runActor(actorInput: HarshmaurActorInput): Promise<unknown[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = {
      accept: "application/json",
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
    };

    try {
      const runEndpoint = new URL(
        `/v2/acts/${encodeURIComponent(this.actorId.replace("/", "~"))}/run-sync`,
        "https://api.apify.com",
      );
      runEndpoint.searchParams.set("timeout", String(Math.ceil(this.timeoutMs / 1000)));

      const runResponse = await this.fetchImpl(runEndpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(actorInput),
        signal: controller.signal,
      });
      const runText = await runResponse.text();
      if (!runResponse.ok) {
        throw new Error(`Harshmaur actor run failed with HTTP ${runResponse.status}.`);
      }

      let datasetId: string | undefined;
      try {
        const parsed = JSON.parse(runText || "{}") as Record<string, unknown>;
        const data = (parsed.data ?? parsed) as Record<string, unknown>;
        datasetId =
          typeof data.defaultDatasetId === "string" ? data.defaultDatasetId : undefined;
      } catch {
        throw new Error("The Harshmaur actor returned invalid JSON.");
      }
      if (!datasetId) throw new Error("The Harshmaur actor run produced no dataset.");

      const pageSize = 100;
      const wanted = actorInput.maxItems;
      const payload: unknown[] = [];
      for (let offset = 0; offset < wanted; offset += pageSize) {
        const limit = Math.min(pageSize, wanted - offset);
        const datasetEndpoint = new URL(
          `/v2/datasets/${encodeURIComponent(datasetId)}/items`,
          "https://api.apify.com",
        );
        datasetEndpoint.searchParams.set("clean", "true");
        datasetEndpoint.searchParams.set("format", "json");
        datasetEndpoint.searchParams.set("limit", String(limit));
        datasetEndpoint.searchParams.set("offset", String(offset));

        const pageResponse = await this.fetchImpl(datasetEndpoint, {
          headers,
          signal: controller.signal,
        });
        if (!pageResponse.ok) {
          throw new Error(`Harshmaur dataset read failed with HTTP ${pageResponse.status}.`);
        }
        const page = (await pageResponse.json()) as unknown;
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
    const maxItems = Math.min(this.maximumItems, Math.max(40, request.limit));
    const actorInput = buildHarshmaurInput(request, {
      maxItems,
      maxTerms: this.maxTerms,
    });
    if (actorInput.searchTerms.length === 0) {
      throw new Error("The company context did not produce any usable Reddit search terms.");
    }

    const payload = await this.runActor(actorInput);
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
