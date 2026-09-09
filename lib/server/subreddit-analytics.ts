import { subredditFromCitationUrl } from "@/lib/server/ai-visibility-analysis";
import type { AiVisibilityAnswer, ScanRecord } from "@/lib/server/contracts";

/**
 * One subreddit's performance row for the Analytics screen's "Subreddit
 * performance" table. Every field here is an aggregation of data that
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
 * Aggregates subreddit performance from the seed scan plus a bounded
 * recent window of ongoing-monitoring run scans, and (separately) from
 * AI Visibility's own stored citations. Read-only: nothing here writes
 * anything, generates a new score, or triggers new scraping.
 *
 * Relevant conversations / Opportunities: OpportunityRecord and
 * MarketIntelligenceRecord can both independently be produced for the
 * same underlying Reddit post in the same scan (isQualifiedPotentialCustomer
 * and isRelevantMarketConversation are applied independently to the same
 * deepRows in scan-workflow.ts, with no mutual exclusion) -- confirmed by
 * reading that code directly before writing this. Deduplicated here by
 * sourceId (the one field both types share, assigned from the same
 * underlying conversation.provenance.id for the same post), so the same
 * conversation is never counted twice just because it exists in both
 * collections. "Relevant conversations" is the size of that deduplicated
 * per-subreddit set; "Opportunities" is how many of those entries are
 * specifically opportunities (a subset, not an addition).
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

  collectFromResult(input.seedScan.result);
  for (const runScan of input.recentRunScans) collectFromResult(runScan.result);

  const citationCounts = new Map<string, number>();
  const citationLatest = new Map<string, string>();
  for (const answer of input.aiVisibilityAnswers) {
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
