import { subredditFromCitationUrl } from "@/lib/server/ai-visibility-analysis";
import type { AiVisibilityAnswer, ScanRecord } from "@/lib/server/contracts";

/**
 * One subreddit's performance row for the Analytics screen's "Top
 * subreddits" table. Every field here is an aggregation of data that
 * already exists on already-persisted records (OpportunityRecord,
 * MarketIntelligenceRecord, AiVisibilityAnswer) -- no new scoring, no new
 * scraping, no new storage. See aggregateSubredditPerformance's own doc
 * comment for exactly which fields feed which column.
 */
export type SubredditPerformanceRow = {
  subreddit: string;
  relevantConversations: number;
  opportunities: number;
  /** Null when nothing in this subreddit had a score to average -- never a fabricated value. */
  avgRelevance: number | null;
  aiCited: number;
  /** ISO timestamp of the most recent relevant conversation, or (for a citation-only row) the citing answer's fetchedAt; null if neither exists. */
  latest: string | null;
};

type ConversationRecord = {
  isOpportunity: boolean;
  researchScore: number;
  postedAt: string;
};

/**
 * The one shared collection step behind every Analytics view on this
 * screen (the table, the KPI row, the activity chart, the donut, and
 * both insight cards) -- so every view agrees on the same dedup rule and
 * none of them can silently drift from another.
 *
 * OpportunityRecord and MarketIntelligenceRecord can both independently
 * be produced for the same underlying Reddit post in the same scan
 * (isQualifiedPotentialCustomer and isRelevantMarketConversation are
 * applied independently to the same deepRows in scan-workflow.ts, with
 * no mutual exclusion) -- confirmed by reading that code directly before
 * writing this. Deduplicated here by sourceId (the one field both types
 * share, assigned from the same underlying conversation.provenance.id
 * for the same post), so the same conversation is never counted twice
 * just because it exists in both collections, and never twice across
 * scans either (the same Map instance accumulates across the seed scan
 * and every recent monitoring-run scan passed in).
 */
export function collectSubredditConversations(
  seedScan: ScanRecord,
  recentRunScans: ScanRecord[],
): Map<string, Map<string, ConversationRecord>> {
  const bySubreddit = new Map<string, Map<string, ConversationRecord>>();

  const recordConversation = (subreddit: string, sourceId: string, entry: ConversationRecord) => {
    const conversations = bySubreddit.get(subreddit) ?? new Map<string, ConversationRecord>();
    const existing = conversations.get(sourceId);
    // An opportunity carries the richer flag; if the same sourceId was
    // already recorded (from either collection or an earlier scan in this
    // same aggregation), never downgrade isOpportunity from true to false.
    if (existing?.isOpportunity) return;
    conversations.set(sourceId, entry);
    bySubreddit.set(subreddit, conversations);
  };

  const collectFromResult = (result: ScanRecord["result"]) => {
    if (!result) return;
    for (const opportunity of result.opportunities) {
      if (!opportunity.subreddit) continue;
      recordConversation(opportunity.subreddit, opportunity.sourceId, {
        isOpportunity: true,
        researchScore: opportunity.researchScore,
        postedAt: opportunity.postedAt,
      });
    }
    for (const intelligence of result.marketIntelligence) {
      if (!intelligence.subreddit) continue;
      recordConversation(intelligence.subreddit, intelligence.sourceId, {
        isOpportunity: false,
        researchScore: intelligence.researchScore,
        postedAt: intelligence.sourceCreatedAt,
      });
    }
  };

  collectFromResult(seedScan.result);
  for (const runScan of recentRunScans) collectFromResult(runScan.result);
  return bySubreddit;
}

function collectCitations(aiVisibilityAnswers: readonly AiVisibilityAnswer[]) {
  const citationCounts = new Map<string, number>();
  const citationLatest = new Map<string, string>();
  for (const answer of aiVisibilityAnswers) {
    for (const citation of answer.redditCitations) {
      const subreddit = subredditFromCitationUrl(citation);
      if (!subreddit) continue;
      citationCounts.set(subreddit, (citationCounts.get(subreddit) ?? 0) + 1);
      const existingLatest = citationLatest.get(subreddit);
      if (!existingLatest || answer.fetchedAt > existingLatest) {
        citationLatest.set(subreddit, answer.fetchedAt);
      }
    }
  }
  return { citationCounts, citationLatest };
}

/**
 * Aggregates subreddit performance from the seed scan plus a bounded
 * recent window of ongoing-monitoring run scans, and (separately) from
 * AI Visibility's own stored citations. Read-only: nothing here writes
 * anything, generates a new score, or triggers new scraping.
 *
 * "Relevant conversations" is the size of collectSubredditConversations'
 * deduplicated per-subreddit set; "Opportunities" is how many of those
 * entries are specifically opportunities (a subset, not an addition).
 *
 * Avg relevance: OpportunityRecord.score/leadScore and
 * MarketIntelligenceRecord.researchScore measure different things
 * (lead-worthiness vs. research value) and are not combined. Both record
 * types do, however, already carry their own researchScore field,
 * computed by the identical researchScore(qualification) function in
 * reddit-pipeline.ts -- confirmed by reading that function, not assumed.
 * That shared, genuinely comparable field is what's averaged here.
 *
 * AI cited: reuses AiVisibilityAnswer.redditCitations, an already-computed
 * field (not re-filtered here), then extracts the subreddit from each
 * citation's own URL (see subredditFromCitationUrl) -- redd.it short
 * links and any other Reddit URL shape without a /r/<subreddit>/ path are
 * left unattributed rather than guessed at, and no redirect is ever
 * resolved.
 *
 * Citation-only subreddits: a subreddit with zero relevant conversations
 * that only ever surfaced via an AI citation is still included, with
 * relevantConversations/opportunities at 0 and avgRelevance left null
 * (never fabricated) -- this shows a marketer that a community is
 * influencing AI answers even before Scooptr has found a relevant
 * conversation there. Its "latest" falls back to the citing answer's own
 * fetchedAt timestamp, since there is no conversation date to use.
 */
export function aggregateSubredditPerformance(input: {
  seedScan: ScanRecord;
  recentRunScans: ScanRecord[];
  aiVisibilityAnswers: readonly AiVisibilityAnswer[];
}): SubredditPerformanceRow[] {
  const bySubreddit = collectSubredditConversations(input.seedScan, input.recentRunScans);
  const { citationCounts, citationLatest } = collectCitations(input.aiVisibilityAnswers);

  const rows: SubredditPerformanceRow[] = [];
  const allSubreddits = new Set([...bySubreddit.keys(), ...citationCounts.keys()]);
  for (const subreddit of allSubreddits) {
    const conversations = [...(bySubreddit.get(subreddit)?.values() ?? [])];
    const scores = conversations.map((conversation) => conversation.researchScore);
    const avgRelevance = scores.length > 0
      ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
      : null;
    const conversationLatest = conversations.reduce<string | null>(
      (max, conversation) => (!max || conversation.postedAt > max ? conversation.postedAt : max),
      null,
    );
    // Prefer the real conversation date; only fall back to the citing
    // answer's fetchedAt when there is no conversation at all to date.
    const latest = conversationLatest ?? citationLatest.get(subreddit) ?? null;
    rows.push({
      subreddit,
      relevantConversations: conversations.length,
      opportunities: conversations.filter((conversation) => conversation.isOpportunity).length,
      avgRelevance,
      aiCited: citationCounts.get(subreddit) ?? 0,
      latest,
    });
  }
  return rows;
}

/** Overall KPI summary for the Analytics screen's top row. Every field is
 * derived purely from the already-computed SubredditPerformanceRow[] --
 * no new data collection. Avg relevance is a count-weighted recombination
 * of each row's own avgRelevance (rows with no score don't contribute),
 * which is mathematically the true overall average, not an average of
 * averages. No historical/previous-period comparison exists anywhere in
 * this data, so there is deliberately no trend/delta field here -- the
 * UI shows a muted "Recent monitoring activity" label instead of a
 * fabricated percentage.
 */
export type SubredditAnalyticsSummary = {
  relevantConversations: number;
  opportunities: number;
  avgRelevance: number | null;
  aiCitedCommunities: number;
};

export function summarizeSubredditAnalytics(rows: SubredditPerformanceRow[]): SubredditAnalyticsSummary {
  const relevantConversations = rows.reduce((sum, row) => sum + row.relevantConversations, 0);
  const opportunities = rows.reduce((sum, row) => sum + row.opportunities, 0);
  const weightedScoreSum = rows.reduce(
    (sum, row) => sum + (row.avgRelevance !== null ? row.avgRelevance * row.relevantConversations : 0),
    0,
  );
  const scoredConversations = rows.reduce(
    (sum, row) => sum + (row.avgRelevance !== null ? row.relevantConversations : 0),
    0,
  );
  const avgRelevance = scoredConversations > 0 ? Math.round(weightedScoreSum / scoredConversations) : null;
  const aiCitedCommunities = rows.filter((row) => row.aiCited > 0).length;
  return { relevantConversations, opportunities, avgRelevance, aiCitedCommunities };
}

/** Top N subreddits by relevant-conversation count, for the donut's
 * "top 4 + Other" grouping and the activity chart's "top 3 + Other"
 * series selection. Pure function over the already-computed rows. */
export function topSubredditsByConversations(rows: SubredditPerformanceRow[], limit: number): string[] {
  return [...rows]
    .filter((row) => row.relevantConversations > 0)
    .sort((a, b) => b.relevantConversations - a.relevantConversations)
    .slice(0, limit)
    .map((row) => row.subreddit);
}

/** "Demand mix by community" donut data: top 4 subreddits by relevant-
 * conversation count, everything else grouped into a real "Other" slice
 * (never a fabricated category) -- no artificial taxonomy is invented.
 * Percentages are derived from real counts, rounded for display only. */
export type DemandMixSlice = {
  label: string;
  count: number;
  percent: number;
};

export function computeDemandMix(rows: SubredditPerformanceRow[]): { total: number; slices: DemandMixSlice[] } {
  const total = rows.reduce((sum, row) => sum + row.relevantConversations, 0);
  if (total === 0) return { total: 0, slices: [] };
  const top = topSubredditsByConversations(rows, 4);
  const topRows = top.map((subreddit) => rows.find((row) => row.subreddit === subreddit)!);
  const topTotal = topRows.reduce((sum, row) => sum + row.relevantConversations, 0);
  const otherCount = total - topTotal;
  const slices: DemandMixSlice[] = topRows.map((row) => ({
    label: row.subreddit,
    count: row.relevantConversations,
    percent: Math.round((row.relevantConversations / total) * 100),
  }));
  if (otherCount > 0) {
    slices.push({ label: "Other", count: otherCount, percent: Math.round((otherCount / total) * 100) });
  }
  return { total, slices };
}

/** "Best opportunity source": the subreddit with the most real
 * opportunities (ties broken by avg relevance). Null when nothing has
 * any opportunities yet -- never a fabricated pick. No "2x better"-style
 * comparison is computed since nothing in this data supports one. */
export function selectBestOpportunitySource(rows: SubredditPerformanceRow[]): SubredditPerformanceRow | null {
  const candidates = rows.filter((row) => row.opportunities > 0);
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    if (b.opportunities !== a.opportunities) return b.opportunities - a.opportunities;
    return (b.avgRelevance ?? -1) - (a.avgRelevance ?? -1);
  })[0];
}

/** "Communities influencing AI answers": subreddits with at least one
 * attributable AI Visibility citation, most-cited first. */
export function selectTopAiCitedCommunities(rows: SubredditPerformanceRow[], limit = 6): SubredditPerformanceRow[] {
  return [...rows]
    .filter((row) => row.aiCited > 0)
    .sort((a, b) => b.aiCited - a.aiCited)
    .slice(0, limit);
}

/** One day's activity for the "Subreddit activity over time" chart --
 * counts per top-3 subreddit plus everything else grouped into "other".
 * Only dates with at least one real conversation appear; no gap-filling,
 * no fabricated dates. */
export type SubredditActivityPoint = {
  date: string;
  series: Record<string, number>;
  other: number;
};

/**
 * Groups collectSubredditConversations' own already-deduplicated output
 * by calendar date (from each conversation's own postedAt/
 * sourceCreatedAt) x the given top subreddits, with everything else
 * folded into "other". Dates are calendar days (YYYY-MM-DD) rather than
 * exact timestamps or monitoring-run buckets -- the most truthful
 * existing grouping available, since a monitoring run's own window
 * doesn't correspond to when a conversation was actually posted.
 */
export function aggregateSubredditActivityTimeline(
  bySubreddit: Map<string, Map<string, ConversationRecord>>,
  topSubreddits: string[],
): SubredditActivityPoint[] {
  const topSet = new Set(topSubreddits);
  const byDate = new Map<string, SubredditActivityPoint>();

  for (const [subreddit, conversations] of bySubreddit) {
    for (const conversation of conversations.values()) {
      const date = conversation.postedAt.slice(0, 10);
      if (!date || Number.isNaN(Date.parse(conversation.postedAt))) continue;
      const point = byDate.get(date) ?? { date, series: Object.fromEntries(topSubreddits.map((name) => [name, 0])), other: 0 };
      if (topSet.has(subreddit)) {
        point.series[subreddit] = (point.series[subreddit] ?? 0) + 1;
      } else {
        point.other += 1;
      }
      byDate.set(date, point);
    }
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
