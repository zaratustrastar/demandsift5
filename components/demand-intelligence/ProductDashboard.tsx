"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { REDDIT_MONITOR_LIMITS } from "@/lib/intelligence/reddit-monitor-limits";

import { redditDemandDemoData } from "./demo-data";
import type {
  BusinessProfile,
  ConversationTheme,
  DemandInsight,
  NavigationSection,
  NavigationSectionId,
  PricingPlan,
  RedditDemandDemoData,
  RedditOpportunity,
  RelevantConversation,
  ScanEvidenceCandidate,
} from "./types";

import styles from "./ProductDashboard.module.css";

type AccessLevel = "free" | "pass" | "core";
type CheckoutPlanId = "full-access-pass" | "core";
type FunnelEventName =
  | "potential_customer_count_revealed"
  | "opportunity_preview_viewed"
  | "suggested_reply_viewed"
  | "locked_results_viewed"
  | "unlock_cta_clicked";

export type RedditConnectionStatus = {
  configured: boolean;
  connected: boolean;
  username: string | null;
  canConnect: boolean;
  requiresPaidAccess: boolean;
};

/**
 * One subreddit's performance row for the Analytics screen -- a plain
 * client-side mirror of SubredditPerformanceRow's fields
 * (lib/server/subreddit-analytics.ts), not an import of the server type
 * itself (see AiVisibilityStatus above for the same pattern already in
 * use in this file).
 */
export type SubredditPerformanceRow = {
  subreddit: string;
  relevantConversations: number;
  opportunities: number;
  avgRelevance: number | null;
  aiCited: number;
  latest: string | null;
};

/** Client-side mirror of SubredditAnalyticsSummary -- the KPI row's own
 * data. Deliberately has no trend/delta field: no historical comparison
 * exists in this data, so the KPI row shows a muted context label
 * instead of a fabricated percentage. */
export type SubredditAnalyticsSummary = {
  relevantConversations: number;
  opportunities: number;
  avgRelevance: number | null;
  aiCitedCommunities: number;
};

/** Client-side mirror of DemandMixSlice -- the donut's own data. */
export type DemandMixSlice = {
  label: string;
  count: number;
  percent: number;
};

/** Client-side mirror of SubredditActivityPoint -- the activity chart's
 * own data. Only dates with real activity appear; series holds a count
 * per top-subreddit name, other holds everything else. */
export type SubredditActivityPoint = {
  date: string;
  series: Record<string, number>;
  other: number;
};

export type SubredditPerformanceSummary = {
  rows: SubredditPerformanceRow[];
  summary: SubredditAnalyticsSummary;
  demandMix: { total: number; slices: DemandMixSlice[] };
  bestOpportunitySource: SubredditPerformanceRow | null;
  aiCitedCommunities: SubredditPerformanceRow[];
  activityTimeline: { series: string[]; points: SubredditActivityPoint[] };
  window: {
    recentRunCount: number;
    hasAiVisibilityData: boolean;
  };
};

export type RedditMonitoringStatus = {
  enabled: boolean;
  watchTerms: Array<{
    value: string;
    kind: "brand" | "competitor" | "keyword" | "subreddit";
    active: boolean;
  }>;
  lastSuccessfulMonitorAt: string | null;
  nextRunAt: string;
};

/**
 * One entry in the workspace's persisted, user-manageable AI Visibility
 * question set -- see AiVisibilityTrackedQuestion in lib/server/contracts.ts.
 * Text is the only identity; there is no id/versioning in this data model.
 */
export type AiVisibilityTrackedQuestion = {
  text: string;
  active: boolean;
};

export type AiVisibilityStatus = {
  enabled: boolean;
  lastSuccessfulScanAt: string | null;
  nextRunAt: string;
  /** NULL until the workspace's first AI Visibility run seeds it -- see runAiVisibilityScan's own doc comment on this. */
  questions: AiVisibilityTrackedQuestion[] | null;
};

/**
 * One daily monitoring run, for the "recent runs" results list -- a plain
 * client-side mirror of the fields of lib/server/contracts.ts's
 * RedditMonitorRunRecord actually needed here, not an import of the server
 * type itself (this is a "use client" component; see AiVisibilityStatus
 * above for the same pattern already in use in this file).
 */
export type RedditMonitorRunSummary = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  createdAt: string;
  /** Set once the run's own scan finishes -- lets "View results" jump straight into that scan's report. */
  scanId: string | null;
  fetched: number;
  normalized: number;
  unseen: number;
  relevant: number;
  opportunities: number;
  error: string | null;
};

export type AiVisibilityProvider = "chatgpt" | "gemini" | "perplexity";

export type AiVisibilityCitationSummary = {
  url: string;
  title: string | null;
  domain: string;
};

export type AiVisibilityAnswerSummary = {
  provider: AiVisibilityProvider;
  question: string;
  answerText: string;
  brandMentioned: boolean;
  brandRecommended: boolean;
  citations: AiVisibilityCitationSummary[];
};

export type AiVisibilityMetricsSummary = {
  totalAnswers: number;
  totalMentions: number;
  mentionRate: number;
  totalRecommendations: number;
  recommendationRate: number;
};

/** One weekly AI visibility scan, for the results view -- see RedditMonitorRunSummary's doc comment for why this is hand-rolled rather than imported. */
export type AiVisibilityScanSummary = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  createdAt: string;
  questions: string[];
  answers: AiVisibilityAnswerSummary[];
  metrics: AiVisibilityMetricsSummary | null;
  /** Per-provider Actor failure reason, e.g. an Apify approval requirement -- see providerErrors on AiVisibilityScanRecord. */
  providerErrors: Record<AiVisibilityProvider, string | null>;
  error: string | null;
};

export interface ProductDashboardProps {
  data?: RedditDemandDemoData;
  /** A complete, source-backed result from the real analysis flow. */
  scanResult?: RedditDemandDemoData;
  /** The domain submitted in the acquisition flow, used only for honest fixture labeling. */
  analyzedDomain?: string;
  initialSection?: NavigationSectionId;
  accessLevel?: AccessLevel;
  onNewScan?: () => void;
  onCheckout?: (planId: CheckoutPlanId) => void;
  onRegenerateReply?: (opportunityId: string) => Promise<string | null>;
  onPublishOpportunity?: (
    opportunityId: string,
    replyText: string,
  ) => Promise<boolean> | boolean;
  /**
   * Persists the person's own manual triage mark (decline / reviewed /
   * replied, or null to undo/clear) for one carousel item -- see
   * PATCH /api/scans/[scanId]/review-mark and ScanRecord.reviewMarks's doc
   * comment in contracts.ts. Returns whether the save succeeded, matching
   * onPublishOpportunity's pattern, so an optimistic local update can be
   * rolled back on failure.
   */
  onSetReviewMark?: (
    itemId: string,
    status: "reviewed" | "declined" | "replied" | null,
  ) => Promise<boolean> | boolean;
  onRecordClick?: (opportunityId: string) => Promise<boolean> | boolean;
  onRecordConversion?: (opportunityId: string) => Promise<boolean> | boolean;
  redditConnection?: RedditConnectionStatus;
  onConnectReddit?: () => void;
  onDisconnectReddit?: () => Promise<void> | void;
  monitoring?: RedditMonitoringStatus | null;
  onUpdateMonitoring?: (
    enabled: boolean,
    watchTerms: RedditMonitoringStatus["watchTerms"],
  ) => Promise<boolean>;
  /** Corrects the "what you sell" summary every qualification judgement and
   * reply draft is grounded in -- see PATCH /api/scans/[scanId]/business-profile. */
  onUpdateBusinessSummary?: (summary: string) => Promise<boolean>;
  /** Recent daily monitoring runs, most recent first -- the "where will I see results" answer for Reddit monitoring. */
  monitorRuns?: RedditMonitorRunSummary[] | null;
  /** Loads a completed monitoring run's own scan into view, in place, without leaving the dashboard. */
  onViewMonitorRun?: (scanId: string) => Promise<void> | void;
  /** The seed scan's own already-found subreddits (see recommendedSubreddits in reddit-monitor-repository.ts) -- feeds the Subreddits section's "Recommended" rows. */
  recommendedSubreddits?: string[] | null;
  /** Aggregated subreddit performance for the Analytics screen (see aggregateSubredditPerformance in lib/server/subreddit-analytics.ts) -- separate from recommendedSubreddits above, which only feeds Monitoring config's control list. */
  subredditPerformance?: SubredditPerformanceSummary | null;
  aiVisibility?: AiVisibilityStatus | null;
  onUpdateAiVisibility?: (
    enabled: boolean,
    questions?: AiVisibilityTrackedQuestion[],
  ) => Promise<boolean>;
  /** Recent weekly AI visibility scans, most recent first -- the "where will I see results" answer for AI visibility tracking. */
  visibilityScans?: AiVisibilityScanSummary[] | null;
  /**
   * Drafts a first reply, on demand, for a relevant conversation (or raw
   * carousel candidate) that does not have one yet -- returns the new
   * draft content, or null on failure (the caller surfaces the error
   * message itself, the same way onRegenerateReply does).
   */
  onCreateReply?: (conversationId: string, externalId: string) => Promise<string | null>;
  onFunnelEvent?: (name: FunnelEventName) => Promise<void> | void;
}

function runStatusLabel(status: "queued" | "running" | "succeeded" | "failed"): string {
  if (status === "succeeded") return "Succeeded";
  if (status === "failed") return "Failed";
  if (status === "running") return "Running";
  return "Queued";
}

function RunStatusBadge({ status }: { status: "queued" | "running" | "succeeded" | "failed" }) {
  const tone =
    status === "succeeded" ? styles.resultsStatusOk : status === "failed" ? styles.resultsStatusFail : styles.resultsStatusPending;
  return <span className={`${styles.resultsStatus} ${tone}`}>{runStatusLabel(status)}</span>;
}

function aiVisibilityProviderLabel(provider: AiVisibilityProvider): string {
  if (provider === "chatgpt") return "ChatGPT";
  if (provider === "gemini") return "Gemini";
  return "Perplexity";
}

const URL_PATTERN = /(https?:\/\/[^\s]+)/g;

/** Renders plain text with any bare https:// URLs turned into clickable links -- used for Apify's own error messages, which sometimes end with a one-time approval URL. */
function LinkifiedText({ text }: { text: string }) {
  const parts = text.split(URL_PATTERN);
  return (
    <>
      {parts.map((part, index) =>
        URL_PATTERN.test(part) ? (
          <a key={index} href={part} target="_blank" rel="noreferrer noopener">
            {part}
          </a>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

/**
 * AI visibility answers come back as raw markdown-ish text straight from
 * each provider (bold via **, GitHub-style tables via | cells |, numbered
 * citation markers like [8][15]) -- rendered as a single <p> with
 * white-space: pre-wrap, that reads as a wall of asterisks and pipes
 * instead of the structured answer it actually is. No markdown library is
 * added for this (the codebase has none, and every other block of AI text
 * in the app is short enough not to need one); this is a small,
 * dependency-free formatter for exactly the 2 constructs actually observed
 * in real answers (tables, bold) plus citation markers, not a general
 * markdown parser.
 */
type AnswerBlock = { type: "paragraph"; text: string } | { type: "table"; rows: string[][] };

function isTableSeparatorRow(line: string): boolean {
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(line);
}

function parseAnswerBlocks(text: string): AnswerBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: AnswerBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.trim().startsWith("|")) {
      const tableLines: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        tableLines.push(lines[index].trim());
        index += 1;
      }
      const rows = tableLines
        .filter((tableLine) => !isTableSeparatorRow(tableLine))
        .map((tableLine) => tableLine.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()));
      if (rows.length > 0) blocks.push({ type: "table", rows });
      continue;
    }
    const paragraphLines: string[] = [];
    while (index < lines.length && lines[index].trim() && !lines[index].trim().startsWith("|")) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
  }
  return blocks;
}

const INLINE_MARKDOWN_PATTERN = /\*\*(.+?)\*\*|\[(\d+)\]/g;

function renderInlineAnswerMarkdown(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let matchIndex = 0;
  for (const match of text.matchAll(INLINE_MARKDOWN_PATTERN)) {
    const start = match.index ?? 0;
    if (start > lastIndex) nodes.push(text.slice(lastIndex, start));
    if (match[1] !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-b-${matchIndex}`}>{match[1]}</strong>);
    } else if (match[2] !== undefined) {
      nodes.push(
        <sup key={`${keyPrefix}-c-${matchIndex}`} className={styles.answerCitationMark}>
          [{match[2]}]
        </sup>,
      );
    }
    lastIndex = start + match[0].length;
    matchIndex += 1;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function FormattedAnswerText({ text }: { text: string }) {
  const blocks = parseAnswerBlocks(text);
  return (
    <div className={styles.answerBody}>
      {blocks.map((block, blockIndex) =>
        block.type === "table" ? (
          <table key={blockIndex} className={styles.answerTable}>
            <thead>
              <tr>
                {block.rows[0]?.map((cell, cellIndex) => (
                  <th key={cellIndex}>{renderInlineAnswerMarkdown(cell, `${blockIndex}-h-${cellIndex}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.slice(1).map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{renderInlineAnswerMarkdown(cell, `${blockIndex}-${rowIndex}-${cellIndex}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p key={blockIndex}>{renderInlineAnswerMarkdown(block.text, `${blockIndex}`)}</p>
        ),
      )}
    </div>
  );
}

/**
 * Corrects the one free-text sentence every qualification judgement and
 * reply draft is grounded in (see lib/server/presenter.ts's
 * applyBusinessSummaryOverride). This is the summary itself, not the
 * derived search terms -- those are already separately editable via the
 * watch-terms textarea below.
 */
function BusinessSummaryEditor({
  summary,
  onUpdate,
}: {
  summary: string;
  onUpdate?: (summary: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState(summary);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const dirty = value.trim() !== summary.trim();

  const save = async () => {
    if (!onUpdate || !value.trim() || saving) return;
    setSaving(true);
    try {
      const ok = await onUpdate(value.trim());
      if (ok) setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={`${styles.card} ${styles.monitoringCard}`}>
      <div>
        <span className={styles.eyebrow}>What you sell</span>
        <h2>Correct your business summary</h2>
        <p>
          Every relevance judgement and drafted reply is grounded in this one sentence. If it
          missed something about what you actually sell or who it&apos;s for, fix it here rather
          than starting a new scan.
        </p>
      </div>
      <label className={styles.monitoringTerms}>
        <span>One-line summary</span>
        <textarea
          value={value}
          rows={3}
          disabled={saving}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
      </label>
      <div className={styles.monitoringFooter}>
        <small>
          {savedAt && !dirty
            ? "Saved. New matches and regenerated replies will use this."
            : "Only applies going forward -- it does not rewrite anything already found."}
        </small>
        <button
          className={styles.primaryButton}
          type="button"
          disabled={saving || !dirty || !value.trim()}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save summary"}
        </button>
      </div>
    </section>
  );
}

function RedditMonitoringPanel({
  monitoring,
  onUpdate,
  runs,
  onViewRun,
  recommendedSubredditNames,
}: {
  monitoring: RedditMonitoringStatus | null;
  onUpdate?: ProductDashboardProps["onUpdateMonitoring"];
  runs?: RedditMonitorRunSummary[] | null;
  onViewRun?: ProductDashboardProps["onViewMonitorRun"];
  recommendedSubredditNames?: string[] | null;
}) {
  // Three sections purely for editing clarity -- RedditWatchTerm already
  // distinguishes kind: "brand" | "competitor" | "keyword" in the
  // persisted model; this just surfaces that existing distinction
  // instead of collapsing all three into one flat textarea. Each box
  // seeds from its matching kind's currently active terms only, the
  // same active-only filtering the single textarea already did.
  const termsByKind = (kind: RedditMonitoringStatus["watchTerms"][number]["kind"]) =>
    monitoring?.watchTerms.filter((term) => term.active && term.kind === kind).map((term) => term.value).join("\n") ?? "";
  const [brandTerms, setBrandTerms] = useState(() => termsByKind("brand"));
  const [competitorTerms, setCompetitorTerms] = useState(() => termsByKind("competitor"));
  const [keywordTerms, setKeywordTerms] = useState(() => termsByKind("keyword"));
  // Subreddits section: "Recommended" is the seed scan's own already-found
  // subreddits (see recommendedSubreddits in reddit-monitor-repository.ts
  // -- a real aggregation of existing OpportunityRecord/
  // MarketIntelligenceRecord.subreddit values, not a new relevance score).
  // A recommended name the user has excluded, or a manually-added name,
  // both persist as kind: "subreddit" watch terms -- active means
  // Included, matching the same active/inactive convention the other
  // three sections already use.
  const [subreddits, setSubreddits] = useState<Array<{ name: string; source: "recommended" | "manual"; active: boolean }>>(() => {
    const existingByName = new Map(
      (monitoring?.watchTerms ?? [])
        .filter((term) => term.kind === "subreddit")
        .map((term) => [term.value.toLocaleLowerCase("en-US"), term]),
    );
    const recommendedSet = new Set((recommendedSubredditNames ?? []).map((name) => name.toLocaleLowerCase("en-US")));
    const rows: Array<{ name: string; source: "recommended" | "manual"; active: boolean }> = (recommendedSubredditNames ?? []).map((name) => ({
      name,
      source: "recommended" as const,
      active: existingByName.get(name.toLocaleLowerCase("en-US"))?.active ?? true,
    }));
    for (const term of existingByName.values()) {
      if (!recommendedSet.has(term.value.toLocaleLowerCase("en-US"))) {
        rows.push({ name: term.value, source: "manual", active: term.active });
      }
    }
    return rows;
  });
  const [newSubreddit, setNewSubreddit] = useState("");
  const [saving, setSaving] = useState(false);
  const [viewingRunId, setViewingRunId] = useState<string | null>(null);
  if (!monitoring) return null;

  const toggleSubreddit = (name: string) => {
    setSubreddits((current) => current.map((row) => (row.name === name ? { ...row, active: !row.active } : row)));
  };
  const removeSubreddit = (name: string) => {
    setSubreddits((current) => current.filter((row) => row.name !== name));
  };
  const addSubreddit = () => {
    const name = newSubreddit.replace(/^\s*r\//i, "").replace(/\s+/g, "").trim();
    if (!name) return;
    if (subreddits.some((row) => row.name.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"))) {
      setNewSubreddit("");
      return;
    }
    setSubreddits((current) => [...current, { name, source: "manual", active: true }]);
    setNewSubreddit("");
  };

  const parseLines = (value: string) =>
    value.split(/\r?\n|,/u).map((line) => line.replace(/\s+/gu, " ").trim()).filter(Boolean);

  // Same combine-dedupe-cap behavior the single textarea already had.
  // kind now comes directly from which box a term was typed into,
  // rather than the old logic's guess (look up an existing term with
  // the same value, or fall back to "keyword") -- each box IS the kind,
  // so there is nothing left to guess. Dedupe key now includes kind, not
  // just value: a competitor named "Notion" and an excluded r/Notion are
  // different things and must not collide into one entry.
  const parsedTerms = (): RedditMonitoringStatus["watchTerms"] => {
    const combined: RedditMonitoringStatus["watchTerms"] = [
      ...parseLines(brandTerms).map((value) => ({ value, kind: "brand" as const, active: true })),
      ...parseLines(competitorTerms).map((value) => ({ value, kind: "competitor" as const, active: true })),
      ...parseLines(keywordTerms).map((value) => ({ value, kind: "keyword" as const, active: true })),
      ...subreddits.map((row) => ({ value: row.name, kind: "subreddit" as const, active: row.active })),
    ];
    const seen = new Set<string>();
    const deduped: RedditMonitoringStatus["watchTerms"] = [];
    for (const term of combined) {
      const key = `${term.kind}:${term.value.toLocaleLowerCase("en-US")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(term);
    }
    return deduped.slice(0, REDDIT_MONITOR_LIMITS.maxWatchTerms);
  };

  const save = async (enabled: boolean) => {
    if (!onUpdate) return;
    setSaving(true);
    try {
      await onUpdate(enabled, parsedTerms());
    } finally {
      setSaving(false);
    }
  };

  const viewRun = async (scanId: string) => {
    if (!onViewRun || viewingRunId) return;
    setViewingRunId(scanId);
    try {
      await onViewRun(scanId);
    } finally {
      setViewingRunId((current) => (current === scanId ? null : current));
    }
  };

  return (
    <section className={`${styles.card} ${styles.monitoringCard}`}>
      <div>
        <span className={styles.eyebrow}>Daily Reddit monitoring</span>
        <h2>Watch new posts and comments once per day</h2>
        <p>
          All active terms are sent together in one daily search. AI checks every unseen match
          for business relevance. Relevant conversations are kept even when they are not leads;
          deeper qualification is reserved for the strongest candidates.
        </p>
      </div>
      <label className={styles.monitoringToggle}>
        <input
          type="checkbox"
          checked={monitoring.enabled}
          disabled={saving}
          onChange={(event) => void save(event.currentTarget.checked)}
        />
        <span>{monitoring.enabled ? "Monitoring on" : "Monitoring off"}</span>
      </label>
      <small className={styles.monitoringTermsNote}>
        Up to {REDDIT_MONITOR_LIMITS.maxWatchTerms} terms across all three sections combined, and{" "}
        {REDDIT_MONITOR_LIMITS.maxResultsPerRun} raw results per daily run.
      </small>
      <label className={styles.monitoringTerms}>
        <span>Brand terms</span>
        <textarea
          value={brandTerms}
          rows={Math.min(6, Math.max(2, brandTerms.split("\n").length))}
          disabled={saving}
          onChange={(event) => setBrandTerms(event.currentTarget.value)}
        />
      </label>
      <label className={styles.monitoringTerms}>
        <span>Competitors</span>
        <textarea
          value={competitorTerms}
          rows={Math.min(6, Math.max(2, competitorTerms.split("\n").length))}
          disabled={saving}
          onChange={(event) => setCompetitorTerms(event.currentTarget.value)}
        />
      </label>
      <label className={styles.monitoringTerms}>
        <span>Topics &amp; phrases</span>
        <textarea
          value={keywordTerms}
          rows={Math.min(8, Math.max(4, keywordTerms.split("\n").length))}
          disabled={saving}
          onChange={(event) => setKeywordTerms(event.currentTarget.value)}
        />
      </label>
      <div className={styles.monitoringTerms}>
        <span>Subreddits</span>
        <small className={styles.monitoringTermsNote}>
          Scooptr automatically monitors relevant communities. You can exclude any that are not useful or add one manually.
        </small>
        {subreddits.length > 0 && (
          <div className={styles.aiVisibilityDrawerBody}>
            {subreddits.map((row) => (
              <div key={row.name} className={styles.manageQuestionRow}>
                <span
                  className={row.active ? styles.manageQuestionText : `${styles.manageQuestionText} ${styles.manageQuestionInactive}`}
                >
                  r/{row.name}
                </span>
                <div className={styles.manageQuestionActions}>
                  <span className={styles.manageQuestionStatus}>
                    {row.source === "recommended" ? "Recommended" : "Added manually"} &middot; {row.active ? "Included" : "Excluded"}
                  </span>
                  <button type="button" className={styles.textButton} disabled={saving} onClick={() => toggleSubreddit(row.name)}>
                    {row.active ? "Exclude" : "Include"}
                  </button>
                  {row.source === "manual" && (
                    <button type="button" className={styles.textButton} disabled={saving} onClick={() => removeSubreddit(row.name)}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className={styles.manageQuestionAddRow}>
          <input
            type="text"
            className={styles.manageQuestionAddInput}
            placeholder="Add a subreddit (e.g. projectmanagement)"
            value={newSubreddit}
            disabled={saving}
            onChange={(event) => setNewSubreddit(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); addSubreddit(); }
            }}
          />
          <button type="button" className={styles.textButton} disabled={saving} onClick={addSubreddit}>
            + Add subreddit
          </button>
        </div>
        <small className={styles.monitoringTermsNote}>
          Adding a subreddit doesn&rsquo;t start a new search there -- it allows its results through when they already match your watch terms.
        </small>
      </div>
      <div className={styles.monitoringFooter}>
        <small>
          {monitoring.lastSuccessfulMonitorAt
            ? `Last successful check ${relativeTime(monitoring.lastSuccessfulMonitorAt)}`
            : "No daily check has completed yet."}
        </small>
        <button className={styles.primaryButton} type="button" disabled={saving} onClick={() => void save(monitoring.enabled)}>
          {saving ? "Saving…" : "Save watch terms"}
        </button>
      </div>
      <div className={styles.resultsBlock}>
        <h3>Recent runs</h3>
        {!runs || runs.length === 0 ? (
          <p className={styles.resultsEmpty}>
            No runs yet -- once monitoring finds unseen matches, each daily run will appear here with what it found.
          </p>
        ) : (
          <ul className={styles.resultsList}>
            {runs.map((run) => (
              <li key={run.id} className={styles.resultsRow}>
                <div className={styles.resultsRowHead}>
                  <RunStatusBadge status={run.status} />
                  <span>{relativeTime(run.createdAt)}</span>
                </div>
                <p className={styles.resultsMeta}>
                  {run.fetched} fetched · {run.normalized} normalized · {run.unseen} unseen · {run.relevant} relevant conversation
                  {run.relevant === 1 ? "" : "s"} · {run.opportunities} lead{run.opportunities === 1 ? "" : "s"}
                </p>
                {run.error && (
                  <p className={styles.resultsError}>
                    <LinkifiedText text={run.error} />
                  </p>
                )}
                {run.scanId && onViewRun && (
                  <button
                    className={styles.textButton}
                    type="button"
                    disabled={viewingRunId === run.scanId}
                    onClick={() => void viewRun(run.scanId as string)}
                  >
                    {viewingRunId === run.scanId ? "Loading…" : "View results"} <Icon name="arrow" size={12} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

type GroupedVisibilityQuestion = {
  question: string;
  answers: AiVisibilityAnswerSummary[];
  mentionedCount: number;
  recommendedCount: number;
  totalSources: number;
};

type SubredditSortColumn = "subreddit" | "relevantConversations" | "opportunities" | "avgRelevance" | "aiCited" | "latest";

/**
 * Default sort mirrors the product's own priority: real demand first.
 * Opportunities desc, then relevant conversations desc, then avg
 * relevance desc (rows with no score sort after rows that have one) --
 * a citation-only row (0 opportunities, 0 conversations, no score)
 * naturally falls to the bottom of this order without any special-case
 * rule, simply because every one of its comparison fields loses to any
 * row with real demand behind it.
 */
function defaultSubredditSort(a: SubredditPerformanceRow, b: SubredditPerformanceRow): number {
  if (b.opportunities !== a.opportunities) return b.opportunities - a.opportunities;
  if (b.relevantConversations !== a.relevantConversations) return b.relevantConversations - a.relevantConversations;
  const aScore = a.avgRelevance ?? -1;
  const bScore = b.avgRelevance ?? -1;
  return bScore - aScore;
}

function sortSubredditRows(rows: SubredditPerformanceRow[], column: SubredditSortColumn, direction: "asc" | "desc"): SubredditPerformanceRow[] {
  const sorted = [...rows].sort((a, b) => {
    switch (column) {
      case "subreddit":
        return a.subreddit.localeCompare(b.subreddit);
      case "relevantConversations":
        return a.relevantConversations - b.relevantConversations;
      case "opportunities":
        return a.opportunities - b.opportunities;
      case "avgRelevance":
        return (a.avgRelevance ?? -1) - (b.avgRelevance ?? -1);
      case "aiCited":
        return a.aiCited - b.aiCited;
      case "latest":
        return (a.latest ?? "").localeCompare(b.latest ?? "");
      default:
        return 0;
    }
  });
  return direction === "asc" ? sorted : sorted.reverse();
}

const SUBREDDIT_COLUMNS: Array<{ id: SubredditSortColumn; label: string; width: string }> = [
  { id: "subreddit", label: "Subreddit", width: "28%" },
  { id: "relevantConversations", label: "Relevant conversations", width: "20%" },
  { id: "opportunities", label: "Opportunities", width: "14%" },
  { id: "avgRelevance", label: "Avg. relevance", width: "14%" },
  { id: "aiCited", label: "AI cited", width: "11%" },
  { id: "latest", label: "Latest", width: "13%" },
];

/**
 * Blue-shade palettes for the two Analytics infographics -- all within
 * the same var(--green)/var(--green-dark)/var(--green-soft) family
 * already used throughout this stylesheet (the variable name is
 * misleading; the actual color is Scooptr's blue accent, #2563eb), not
 * RedShip's colors or a new palette.
 */
const ACTIVITY_SERIES_COLORS = ["#1d4ed8", "#2563eb", "#60a5fa"];
const ACTIVITY_OTHER_COLOR = "#c7d9fb";
const DONUT_COLORS = ["#1e3a8a", "#1d4ed8", "#2563eb", "#60a5fa", "#c7d9fb"];

function formatShortChartDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * Four compact KPI cards. Every value comes straight from
 * SubredditAnalyticsSummary (a pure aggregation of the already-fetched
 * rows -- see summarizeSubredditAnalytics in subreddit-analytics.ts).
 * Deliberately no trend arrows or +N% deltas: no previous-period data
 * exists anywhere in this aggregation to support one truthfully, so a
 * single shared muted label explains the omission instead of a fabricated
 * number appearing next to each card.
 */
function AnalyticsKpiRow({ data }: { data: SubredditPerformanceSummary | null }) {
  if (!data) return null;
  const { summary } = data;
  const cards = [
    { label: "Relevant conversations", value: summary.relevantConversations },
    { label: "Opportunities", value: summary.opportunities },
    { label: "Avg relevance", value: summary.avgRelevance === null ? "\u2014" : summary.avgRelevance },
    { label: "AI-cited communities", value: summary.aiCitedCommunities },
  ];
  return (
    <div className={styles.analyticsKpiSection}>
      <div className={styles.analyticsKpiRow}>
        {cards.map((card) => (
          <div className={styles.analyticsKpiCard} key={card.label}>
            <strong>{card.value}</strong>
            <span>{card.label}</span>
          </div>
        ))}
      </div>
      <small className={styles.monitoringTermsNote}>Recent monitoring activity</small>
    </div>
  );
}

/**
 * "Subreddit activity over time" -- stacked vertical bars, one per
 * calendar date that actually has activity (see
 * aggregateSubredditActivityTimeline's own doc comment: no gap-filling,
 * no fabricated dates). Top 3 subreddits by relevant-conversation count
 * are their own series; everything else is folded into a single "Other"
 * segment per bar, matching what was specified rather than inventing a
 * longer legend. Plain hand-rolled SVG -- no chart library exists in
 * this project (checked package.json and the whole codebase before
 * writing this), and a library isn't needed for a chart this simple.
 */
function SubredditActivityChart({ data }: { data: SubredditPerformanceSummary | null }) {
  if (!data) return null;
  const { series, points } = data.activityTimeline;
  const chartWidth = 560;
  const chartHeight = 190;
  const paddingBottom = 22;
  const plotHeight = chartHeight - paddingBottom;
  const maxTotal = Math.max(
    1,
    ...points.map((point) => series.reduce((sum, name) => sum + (point.series[name] ?? 0), point.other)),
  );
  const step = points.length > 0 ? chartWidth / points.length : chartWidth;
  const barWidth = Math.min(30, step - 8);
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));

  return (
    <section className={`${styles.card} ${styles.analyticsChartCard}`}>
      <h2>Subreddit activity over time</h2>
      <p className={styles.analyticsCardSubtitle}>Relevant conversations found across monitored communities.</p>
      {points.length === 0 ? (
        <p className={styles.resultsEmpty}>Not enough dated activity yet to chart.</p>
      ) : (
        <>
          <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} className={styles.analyticsActivitySvg} role="img" aria-label="Subreddit activity over time">
            {points.map((point, index) => {
              const x = index * step + (step - barWidth) / 2;
              const segments = [
                ...series.map((name, seriesIndex) => ({ value: point.series[name] ?? 0, color: ACTIVITY_SERIES_COLORS[seriesIndex] })),
                { value: point.other, color: ACTIVITY_OTHER_COLOR },
              ];
              let cursorY = plotHeight;
              return (
                <g key={point.date}>
                  {segments.map((segment, segmentIndex) => {
                    if (segment.value <= 0) return null;
                    const height = (segment.value / maxTotal) * plotHeight;
                    cursorY -= height;
                    return <rect key={segmentIndex} x={x} y={cursorY} width={barWidth} height={height} fill={segment.color} rx={2} />;
                  })}
                  {index % labelEvery === 0 && (
                    <text x={x + barWidth / 2} y={chartHeight - 6} textAnchor="middle" fontSize="14" fill="#8b93a1">
                      {formatShortChartDate(point.date)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          <div className={styles.analyticsChartLegend}>
            {series.map((name, index) => (
              <span key={name}>
                <i style={{ background: ACTIVITY_SERIES_COLORS[index] }} />r/{name}
              </span>
            ))}
            <span>
              <i style={{ background: ACTIVITY_OTHER_COLOR }} />Other
            </span>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * "Demand mix by community" -- a real donut, not an artificial taxonomy:
 * top 4 subreddits by relevant-conversation count plus a genuine "Other"
 * slice (see computeDemandMix). Percentages are the real per-slice
 * counts divided by the real total. Standard SVG donut technique
 * (stroke-dasharray segments around a circle) -- no chart library.
 */
function DemandMixDonut({ data }: { data: SubredditPerformanceSummary | null }) {
  if (!data) return null;
  const { total, slices } = data.demandMix;
  const radius = 60;
  const circumference = 2 * Math.PI * radius;
  const segments = slices.reduce<Array<DemandMixSlice & { dash: number; offset: number; color: string }>>((accumulated, slice, index) => {
    const dash = (slice.percent / 100) * circumference;
    const offset = accumulated.reduce((sum, previous) => sum + previous.dash, 0);
    accumulated.push({ ...slice, dash, offset, color: DONUT_COLORS[index] ?? DONUT_COLORS[DONUT_COLORS.length - 1] });
    return accumulated;
  }, []);

  return (
    <section className={`${styles.card} ${styles.analyticsDonutCard}`}>
      <h2>Demand mix by community</h2>
      {total === 0 || segments.length === 0 ? (
        <p className={styles.resultsEmpty}>No relevant conversations yet to chart.</p>
      ) : (
        <div className={styles.analyticsDonutBody}>
          <svg viewBox="0 0 160 160" className={styles.analyticsDonutSvg} role="img" aria-label="Demand mix by community">
            <g transform="rotate(-90 80 80)">
              {segments.map((segment) => (
                <circle
                  key={segment.label}
                  cx={80}
                  cy={80}
                  r={radius}
                  fill="none"
                  stroke={segment.color}
                  strokeWidth={22}
                  strokeDasharray={`${segment.dash} ${circumference - segment.dash}`}
                  strokeDashoffset={-segment.offset}
                />
              ))}
            </g>
            <text x="80" y="76" textAnchor="middle" fontSize="22" fontWeight="700" fill="var(--ink)">{total}</text>
            <text x="80" y="94" textAnchor="middle" fontSize="10" fill="var(--muted)">conversations</text>
          </svg>
          <div className={styles.analyticsChartLegend}>
            {segments.map((segment) => (
              <span key={segment.label}>
                <i style={{ background: segment.color }} />
                {segment.label === "Other" ? "Other" : `r/${segment.label}`} &middot; {segment.percent}%
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * "Best opportunity source" -- the subreddit with the real highest
 * opportunity count (see selectBestOpportunitySource). No "2x better"
 * or similar comparison is computed; nothing in this data supports one
 * truthfully.
 */
function BestOpportunitySourceCard({ data }: { data: SubredditPerformanceSummary | null }) {
  if (!data) return null;
  const best = data.bestOpportunitySource;
  return (
    <section className={`${styles.card} ${styles.analyticsInsightCard}`}>
      <span className={styles.analyticsInsightLabel}>Best opportunity source</span>
      {best ? (
        <>
          <h3>r/{best.subreddit}</h3>
          <div className={styles.analyticsInsightStats}>
            <span><strong>{best.opportunities}</strong> opportunit{best.opportunities === 1 ? "y" : "ies"}</span>
            {best.avgRelevance !== null && <span><strong>{best.avgRelevance}</strong> avg relevance</span>}
          </div>
        </>
      ) : (
        <p className={styles.resultsEmpty}>No opportunities found yet in any monitored community.</p>
      )}
    </section>
  );
}

/**
 * "Communities influencing AI answers" -- subreddits with at least one
 * attributable AI Visibility citation (see selectTopAiCitedCommunities),
 * as compact pills. Only citations where the subreddit was
 * deterministically extractable from a standard Reddit URL are counted
 * here at all -- no redd.it resolution, no additional network requests.
 */
function AiCitedCommunitiesCard({ data }: { data: SubredditPerformanceSummary | null }) {
  if (!data) return null;
  const communities = data.aiCitedCommunities;
  return (
    <section className={`${styles.card} ${styles.analyticsInsightCard}`}>
      <span className={styles.analyticsInsightLabel}>Communities influencing AI answers</span>
      {communities.length > 0 ? (
        <div className={styles.analyticsPillRow}>
          {communities.map((row) => (
            <span className={styles.analyticsPill} key={row.subreddit}>r/{row.subreddit}</span>
          ))}
        </div>
      ) : (
        <p className={styles.resultsEmpty}>No AI Visibility citations attributable to a subreddit yet.</p>
      )}
    </section>
  );
}

/**
 * "Subreddit performance" -- the Analytics screen's one table for this
 * task (no charts yet, per scope). Reuses the existing .answerTable
 * style (built for the AI Visibility results redesign) rather than
 * introducing a new table look. Sorting is a plain local click-to-sort
 * on already-fetched rows; the data itself was never re-ranked, just
 * reordered.
 */
function SubredditPerformanceTable({ data }: { data: SubredditPerformanceSummary | null }) {
  const [sortColumn, setSortColumn] = useState<SubredditSortColumn | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

  const clickColumn = (column: SubredditSortColumn) => {
    if (sortColumn === column) {
      setSortDirection((current) => (current === "desc" ? "asc" : "desc"));
    } else {
      setSortColumn(column);
      setSortDirection("desc");
    }
  };

  const sortedRows = sortColumn ? sortSubredditRows(data?.rows ?? [], sortColumn, sortDirection) : [...(data?.rows ?? [])].sort(defaultSubredditSort);

  return (
    <section className={`${styles.card} ${styles.subredditTopCard}`}>
      <div className={styles.subredditTopHeader}>
        <div className={styles.subredditTopTitleRow}>
          {/* The real, supplied Reddit logo asset -- never recreated with
           * CSS/an icon library/emoji. Sized subtly and kept at its
           * correct square aspect ratio. */}
          <img src="/logos/reddit-mark.png" alt="Reddit" className={styles.subredditTopIcon} width={22} height={22} />
          <h2>Top subreddits</h2>
          {data && data.rows.length > 0 && <span className={styles.subredditTopCount}>{data.rows.length}</span>}
        </div>
        <p>Communities producing the most relevant conversations and opportunities.</p>
      </div>
      {!data ? (
        // Reuses the same generic spinner already built for AI Visibility
        // (aiVisibilityLoading/aiVisibilitySpinner) rather than a new
        // loading treatment -- this table's own data can take a moment
        // to aggregate, so a blank section here would look broken.
        <div className={styles.aiVisibilityLoading}>
          <span className={styles.aiVisibilitySpinner} aria-hidden="true" />
          <div>
            <strong>Loading subreddit performance</strong>
            <p>Aggregating your scan and recent monitoring activity.</p>
          </div>
        </div>
      ) : data.rows.length === 0 ? (
        <p className={styles.resultsEmpty}>
          No subreddit activity yet -- once Scooptr finds relevant conversations or AI Visibility cites a community, it will appear here.
        </p>
      ) : (
        <>
          {/*
           * A CSS Grid data list, not an HTML <table>. The header row and
           * every data row are separate grid containers that all apply
           * the exact same styles.subredditTopGrid class -- one single
           * grid-template-columns definition, defined once, used
           * everywhere -- so every value is guaranteed to sit directly
           * beneath its column heading rather than relying on <table>'s
           * own column-width negotiation (which visibly drifted by a
           * few pixels per column in production). role="table"/"row"/
           * "columnheader"/"cell" preserve the same screen-reader
           * semantics a real <table> would have had.
           */}
          <div className={styles.subredditTableScroll}>
            <div className={styles.subredditTopGridContainer} role="table" aria-label="Top subreddits">
              <div className={`${styles.subredditTopGrid} ${styles.subredditTopGridHead}`} role="row">
                {SUBREDDIT_COLUMNS.map((column) => (
                  <div
                    key={column.id}
                    className={column.id === "subreddit" ? styles.subredditGridCell : `${styles.subredditGridCell} ${styles.subredditGridCellRight}`}
                    role="columnheader"
                  >
                    <button type="button" className={styles.textButton} onClick={() => clickColumn(column.id)}>
                      {column.label}
                      {sortColumn === column.id ? (sortDirection === "desc" ? " \u2193" : " \u2191") : ""}
                    </button>
                  </div>
                ))}
              </div>
              {sortedRows.map((row) => (
                <div className={styles.subredditTopGrid} role="row" key={row.subreddit}>
                  <div className={`${styles.subredditGridCell} ${styles.subredditNameCell}`} role="cell">r/{row.subreddit}</div>
                  <div className={`${styles.subredditGridCell} ${styles.subredditGridCellRight} ${styles.subredditNumericCell}`} role="cell">
                    {row.relevantConversations > 0 ? row.relevantConversations : <span className={styles.subredditMuted}>0</span>}
                  </div>
                  <div className={`${styles.subredditGridCell} ${styles.subredditGridCellRight} ${styles.subredditNumericCell}`} role="cell">
                    {row.opportunities > 0 ? (
                      <span className={styles.subredditOpportunitiesValue}>{row.opportunities}</span>
                    ) : (
                      <span className={styles.subredditMuted}>0</span>
                    )}
                  </div>
                  <div className={`${styles.subredditGridCell} ${styles.subredditGridCellRight} ${styles.subredditNumericCell}`} role="cell">
                    {row.avgRelevance === null ? (
                      <span className={styles.subredditMuted}>{"\u2014"}</span>
                    ) : row.avgRelevance >= 85 ? (
                      <span className={styles.subredditScoreHigh}>{row.avgRelevance}</span>
                    ) : (
                      <span className={styles.subredditScore}>{row.avgRelevance}</span>
                    )}
                  </div>
                  <div className={`${styles.subredditGridCell} ${styles.subredditGridCellRight} ${styles.subredditNumericCell}`} role="cell">
                    {row.aiCited > 0 ? <span className={styles.subredditAiCited}>{row.aiCited}</span> : <span className={styles.subredditMuted}>0</span>}
                  </div>
                  <div className={`${styles.subredditGridCell} ${styles.subredditGridCellRight} ${styles.subredditNumericCell} ${styles.subredditLatestCell}`} role="cell">
                    {row.latest ? relativeTime(row.latest) : <span className={styles.subredditMuted}>{"\u2014"}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <small className={styles.subredditTopFootnote}>Based on the initial scan and recent monitoring activity.</small>
        </>
      )}
    </section>
  );
}

/**
 * Groups the scan's flat answers list (provider x question, up to 9
 * entries) by question text -- the same 3 questions are asked of every
 * provider (see ai-visibility-workflow.ts's generateQuestions, called
 * once and reused for all 3 Actor runs), so exact-string grouping is
 * reliable, not a heuristic. scan.questions (not the answers array
 * itself) is the authoritative list of tracked questions, so a question
 * every provider failed to answer still gets its own row rather than
 * silently disappearing.
 */
function groupVisibilityAnswersByQuestion(scan: AiVisibilityScanSummary): GroupedVisibilityQuestion[] {
  const byQuestion = new Map<string, AiVisibilityAnswerSummary[]>();
  for (const answer of scan.answers) {
    const list = byQuestion.get(answer.question) ?? [];
    list.push(answer);
    byQuestion.set(answer.question, list);
  }
  return scan.questions.map((question) => {
    const answers = byQuestion.get(question) ?? [];
    return {
      question,
      answers,
      mentionedCount: answers.filter((answer) => answer.brandMentioned).length,
      recommendedCount: answers.filter((answer) => answer.brandRecommended).length,
      totalSources: answers.reduce((sum, answer) => sum + answer.citations.length, 0),
    };
  });
}

/**
 * Compact, generic loading state -- shown only while the latest scan is
 * running/queued and no earlier successful result exists to show
 * instead (once a successful result exists, a slower newer check runs
 * quietly behind it rather than replacing good results with a spinner).
 * No fake percentages or per-provider progress bars: scan.status
 * (queued/running/succeeded/failed) is the only genuine run-level
 * status in the data model. providerErrors exists but is only populated
 * after a provider has actually failed, never as an "in progress"
 * signal during a run -- there is no genuine per-provider running state
 * to show honestly, so this stays one generic state as the spec allows.
 */
function AiVisibilityLoadingState() {
  return (
    <div className={styles.aiVisibilityLoading}>
      <span className={styles.aiVisibilitySpinner} aria-hidden="true" />
      <div>
        <strong>Checking your AI visibility now</strong>
        <p>We&rsquo;re asking the same buyer questions across ChatGPT, Gemini and Perplexity.</p>
        <p>Usually takes a few minutes.</p>
        <p className={styles.resultsMeta}>
          Results will appear here automatically. You can leave this page while the check continues.
        </p>
      </div>
    </div>
  );
}

/**
 * One compact row per tracked buyer question -- the primary grouping is
 * by question, not by provider, since the useful comparison is how
 * differently ChatGPT/Gemini/Perplexity answer the exact same question.
 * No full answer text here; that only appears in the detail drawer.
 */
function TrackedQuestionRow({
  grouped,
  onOpen,
}: {
  grouped: GroupedVisibilityQuestion;
  onOpen: () => void;
}) {
  const total = grouped.answers.length || 3;
  return (
    <button type="button" className={styles.trackedQuestionRow} onClick={onOpen}>
      <span className={styles.trackedQuestionText}>{grouped.question}</span>
      <span className={styles.trackedQuestionMeta}>
        Mentioned {grouped.mentionedCount}/{total}
        {" \u00b7 "}Recommended {grouped.recommendedCount}/{total}
        {grouped.totalSources > 0 && (
          <>{" \u00b7 "}{grouped.totalSources} source{grouped.totalSources === 1 ? "" : "s"}</>
        )}
      </span>
      <span className={styles.trackedQuestionArrow} aria-hidden="true">
        View <Icon name="arrow" size={12} />
      </span>
    </button>
  );
}

/**
 * Right-side details drawer for one tracked question. No drawer/sheet
 * component exists anywhere in this codebase (checked before writing
 * this) and none was added -- this reuses the same overlay/backdrop
 * technique as the existing value-prop modal (.valuePropOverlay,
 * .valuePropClose), just anchored to the right edge via new CSS instead
 * of centered. Answers are grouped by provider (ChatGPT, then Gemini,
 * then Perplexity) per spec, rendered with the same FormattedAnswerText
 * this screen's old flat list already used -- no new markdown
 * dependency, and the raw answer text/sources are shown exactly as
 * stored, never truncated, regenerated, or re-summarized.
 */
function AiVisibilityAnswerDrawer({
  grouped,
  checkedAt,
  onClose,
}: {
  grouped: GroupedVisibilityQuestion;
  checkedAt: string;
  onClose: () => void;
}) {
  const order: AiVisibilityProvider[] = ["chatgpt", "gemini", "perplexity"];
  const byProvider = new Map(grouped.answers.map((answer) => [answer.provider, answer]));
  return (
    <div className={styles.aiVisibilityDrawerOverlay}>
      <div className={styles.aiVisibilityDrawer}>
        <button type="button" className={styles.valuePropClose} onClick={onClose} aria-label="Close">
          &times;
        </button>
        <span className={styles.simpleCardEyebrow}>Tracked question</span>
        <h2 className={styles.aiVisibilityDrawerTitle}>{grouped.question}</h2>
        <p className={styles.resultsMeta}>Last checked {relativeTime(checkedAt)}</p>
        <div className={styles.aiVisibilityDrawerBody}>
          {order.map((provider) => {
            const answer = byProvider.get(provider);
            return (
              <section key={provider} className={styles.aiVisibilityDrawerProvider}>
                <div className={styles.resultsRowHead}>
                  <span className={styles.resultsProvider}>{aiVisibilityProviderLabel(provider)}</span>
                  {answer ? (
                    <span
                      className={`${styles.resultsStatus} ${answer.brandMentioned ? styles.resultsStatusOk : styles.resultsStatusPending}`}
                    >
                      {answer.brandMentioned ? "Mentioned" : "Not mentioned"}
                      {answer.brandMentioned
                        ? ` \u00b7 ${answer.brandRecommended ? "Recommended" : "Not recommended"}`
                        : ""}
                    </span>
                  ) : (
                    <span className={`${styles.resultsStatus} ${styles.resultsStatusFail}`}>No answer</span>
                  )}
                </div>
                {answer?.answerText ? (
                  <>
                    <FormattedAnswerText text={answer.answerText} />
                    {answer.citations.length > 0 && (
                      <>
                        <p className={styles.resultsMeta}>
                          Sources &middot; {answer.citations.length}
                        </p>
                        <ul className={styles.resultsCitations}>
                          {answer.citations.map((citation) => (
                            <li key={citation.url}>
                              <a href={citation.url} target="_blank" rel="noreferrer noopener">
                                {citation.title || citation.domain}
                              </a>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </>
                ) : (
                  <p className={styles.resultsEmpty}>No answer was returned for this question.</p>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * "Manage questions" -- reuses the exact same overlay/drawer technique as
 * AiVisibilityAnswerDrawer above (built for the AI Visibility results
 * redesign), since that is already the simplest existing-style management
 * UI in this codebase, rather than inventing a second overlay pattern for
 * this screen. Edits are staged locally (add/edit/enable-disable/remove)
 * and only sent to the server on "Save changes," via the exact same PUT
 * the tracking toggle already uses (see updateAiVisibility in
 * ThreadlineExperience.tsx) -- same "send the full list, replace
 * wholesale" pattern as Reddit monitoring's own watch-term save.
 *
 * The 1-10-active and no-duplicate rules are enforced here too (not just
 * server-side) so the person sees why an action didn't take effect
 * immediately, rather than only after a failed save round-trip -- but the
 * server (sanitizeTrackedQuestions in ai-visibility-repository.ts) is the
 * real authority; this is a UX convenience, not the only place the rule
 * is enforced.
 */
function ManageQuestionsPanel({
  questions,
  onSave,
  onClose,
}: {
  questions: AiVisibilityTrackedQuestion[];
  onSave: (questions: AiVisibilityTrackedQuestion[]) => Promise<boolean>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<AiVisibilityTrackedQuestion[]>(questions);
  const [newQuestion, setNewQuestion] = useState("");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingText, setEditingText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeCount = draft.filter((question) => question.active).length;
  const normalized = (value: string) => value.replace(/\s+/g, " ").trim();
  const isDuplicate = (text: string, skipIndex?: number) =>
    draft.some((question, index) => index !== skipIndex && question.text.toLocaleLowerCase("en-US") === text.toLocaleLowerCase("en-US"));

  const addQuestion = () => {
    const text = normalized(newQuestion);
    if (!text) return;
    if (isDuplicate(text)) { setError("That question is already tracked."); return; }
    if (activeCount >= 10) { setError("Up to 10 questions can be active at once. Disable one first."); return; }
    setDraft((current) => [...current, { text, active: true }]);
    setNewQuestion("");
    setError(null);
  };

  const toggleActive = (index: number) => {
    const target = draft[index];
    if (target.active && activeCount <= 1) { setError("At least 1 question must stay active."); return; }
    setDraft((current) => current.map((question, i) => (i === index ? { ...question, active: !question.active } : question)));
    setError(null);
  };

  const removeQuestion = (index: number) => {
    const target = draft[index];
    if (target.active && activeCount <= 1) {
      setError("At least 1 question must stay active. Enable or add another before removing this one.");
      return;
    }
    setDraft((current) => current.filter((_, i) => i !== index));
    if (editingIndex === index) setEditingIndex(null);
    setError(null);
  };

  const startEdit = (index: number) => {
    setEditingIndex(index);
    setEditingText(draft[index].text);
    setError(null);
  };

  const saveEdit = () => {
    if (editingIndex === null) return;
    const text = normalized(editingText);
    if (!text) { setError("Questions can't be empty."); return; }
    if (isDuplicate(text, editingIndex)) { setError("That question is already tracked."); return; }
    setDraft((current) => current.map((question, i) => (i === editingIndex ? { ...question, text } : question)));
    setEditingIndex(null);
    setEditingText("");
    setError(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const ok = await onSave(draft);
      if (ok) onClose();
      else setError("Your changes could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.aiVisibilityDrawerOverlay}>
      <div className={styles.aiVisibilityDrawer}>
        <button type="button" className={styles.valuePropClose} onClick={onClose} aria-label="Close">
          &times;
        </button>
        <span className={styles.simpleCardEyebrow}>AI Visibility</span>
        <h2 className={styles.aiVisibilityDrawerTitle}>Manage questions</h2>
        <p className={styles.resultsMeta}>
          The buyer questions Scooptr asks ChatGPT, Gemini and Perplexity every week. Keep between 1 and 10 active.
        </p>
        <div className={styles.aiVisibilityDrawerBody}>
          {draft.map((question, index) => (
            <div key={index} className={styles.manageQuestionRow}>
              {editingIndex === index ? (
                <>
                  <textarea
                    className={styles.manageQuestionEditInput}
                    value={editingText}
                    rows={2}
                    onChange={(event) => setEditingText(event.currentTarget.value)}
                  />
                  <div className={styles.manageQuestionActions}>
                    <button type="button" className={styles.textButton} onClick={saveEdit}>Save</button>
                    <button type="button" className={styles.textButton} onClick={() => setEditingIndex(null)}>Cancel</button>
                  </div>
                </>
              ) : (
                <>
                  <span className={question.active ? styles.manageQuestionText : `${styles.manageQuestionText} ${styles.manageQuestionInactive}`}>
                    {question.text}
                  </span>
                  <div className={styles.manageQuestionActions}>
                    <span className={styles.manageQuestionStatus}>{question.active ? "Active" : "Disabled"}</span>
                    <button type="button" className={styles.textButton} onClick={() => toggleActive(index)}>
                      {question.active ? "Disable" : "Enable"}
                    </button>
                    <button type="button" className={styles.textButton} onClick={() => startEdit(index)}>Edit</button>
                    <button type="button" className={styles.textButton} onClick={() => removeQuestion(index)}>Remove</button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
        <div className={styles.manageQuestionAddRow}>
          <input
            type="text"
            className={styles.manageQuestionAddInput}
            placeholder="Add a question"
            value={newQuestion}
            onChange={(event) => setNewQuestion(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addQuestion(); } }}
          />
          <button type="button" className={styles.textButton} onClick={addQuestion}>+ Add question</button>
        </div>
        {error && <p className={styles.resultsError}>{error}</p>}
        <div className={styles.monitoringFooter}>
          <small>{activeCount} of 10 active</small>
          <button type="button" className={styles.primaryButton} disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AiVisibilityPanel({
  status,
  onUpdate,
  scans,
}: {
  status: AiVisibilityStatus | null;
  onUpdate?: ProductDashboardProps["onUpdateAiVisibility"];
  scans?: AiVisibilityScanSummary[] | null;
}) {
  const [saving, setSaving] = useState(false);
  const [openQuestion, setOpenQuestion] = useState<string | null>(null);
  const [managingQuestions, setManagingQuestions] = useState(false);
  if (!status) return null;

  const save = async (enabled: boolean) => {
    if (!onUpdate) return;
    setSaving(true);
    try {
      await onUpdate(enabled);
    } finally {
      setSaving(false);
    }
  };

  // Always sends the current enabled value alongside the edited question
  // list -- the PUT route requires enabled on every request; this call
  // only ever changes questions, never the on/off state itself.
  const saveQuestions = (questions: AiVisibilityTrackedQuestion[]) =>
    onUpdate ? onUpdate(status.enabled, questions) : Promise.resolve(false);

  const latest = scans?.[0] ?? null;
  // The main content shows the most recent SUCCESSFUL check even if a
  // newer running/failed attempt exists on top of it -- a still-running
  // recheck must not blank out a perfectly good prior result.
  const latestSucceeded = scans?.find((scan) => scan.status === "succeeded") ?? null;
  const isChecking = !latestSucceeded && (latest?.status === "running" || latest?.status === "queued");
  const providerErrors = latest
    ? (Object.entries(latest.providerErrors) as Array<[AiVisibilityProvider, string | null]>).filter(
        ([, message]) => Boolean(message),
      )
    : [];
  const grouped = latestSucceeded ? groupVisibilityAnswersByQuestion(latestSucceeded) : [];
  const openGrouped = grouped.find((item) => item.question === openQuestion) ?? null;

  return (
    <section className={`${styles.card} ${styles.monitoringCard}`}>
      {latestSucceeded ? (
        // Requirement 2: once a successful result exists, the large
        // introductory hero stops being the dominant content -- same
        // plain header/subhead every other Scooptr screen uses.
        <div>
          <span className={styles.eyebrow}>AI Visibility</span>
          <h2>See how AI assistants represent your business</h2>
        </div>
      ) : (
        <div>
          <span className={styles.eyebrow}>AI visibility tracking</span>
          <h2>See how ChatGPT, Gemini and Perplexity answer about you</h2>
          <p>
            Once a week, the same questions are put to ChatGPT, Gemini and Perplexity to check whether
            your business is mentioned or recommended, and which sources they cite.
          </p>
        </div>
      )}
      <label className={styles.monitoringToggle}>
        <input
          type="checkbox"
          checked={status.enabled}
          disabled={saving}
          onChange={(event) => void save(event.currentTarget.checked)}
        />
        <span>{status.enabled ? "Tracking on" : "Tracking off"}</span>
      </label>
      <div className={styles.monitoringFooter}>
        <small>
          {status.lastSuccessfulScanAt
            ? `Last successful check ${relativeTime(status.lastSuccessfulScanAt)}`
            : "No weekly check has completed yet."}
        </small>
      </div>

      {isChecking && (
        <div className={styles.resultsBlock}>
          <AiVisibilityLoadingState />
        </div>
      )}

      {!latestSucceeded && !isChecking && (
        <div className={styles.resultsBlock}>
          <h3>Latest results</h3>
          {!latest ? (
            <p className={styles.resultsEmpty}>
              No weekly check has completed yet. Once one runs, ChatGPT, Gemini and Perplexity&rsquo;s answers will appear here.
            </p>
          ) : (
            <>
              <div className={styles.resultsRowHead}>
                <RunStatusBadge status={latest.status} />
                <span>{relativeTime(latest.createdAt)}</span>
              </div>
              {latest.error && (
                <p className={styles.resultsError}>
                  <LinkifiedText text={latest.error} />
                </p>
              )}
              {providerErrors.map(([provider, message]) => (
                <p key={provider} className={styles.resultsError}>
                  <strong>{aiVisibilityProviderLabel(provider)}: </strong>
                  <LinkifiedText text={message as string} />
                </p>
              ))}
            </>
          )}
        </div>
      )}

      {latestSucceeded && (
        <div className={styles.resultsBlock}>
          {/* Requirement 3: three compact summary metrics, reusing the
              same metric-card component the Overview screen already
              uses (scMetricCard/scMetricLabel/scMetricValue/scMetricNote)
              rather than a new card style. */}
          <div className={styles.aiVisibilityMetricsRow}>
            <div className={styles.scMetricCard}>
              <span className={styles.scMetricLabel}>Mentioned</span>
              <span className={styles.scMetricValue}>
                {latestSucceeded.metrics?.totalMentions ?? 0} / {latestSucceeded.metrics?.totalAnswers ?? 0}
              </span>
              <span className={styles.scMetricNote}>
                {Math.round((latestSucceeded.metrics?.mentionRate ?? 0) * 100)}%
              </span>
            </div>
            <div className={styles.scMetricCard}>
              <span className={styles.scMetricLabel}>Recommended</span>
              <span className={styles.scMetricValue}>
                {latestSucceeded.metrics?.totalRecommendations ?? 0} / {latestSucceeded.metrics?.totalAnswers ?? 0}
              </span>
              <span className={styles.scMetricNote}>
                {Math.round((latestSucceeded.metrics?.recommendationRate ?? 0) * 100)}%
              </span>
            </div>
            <div className={styles.scMetricCard}>
              <span className={styles.scMetricLabel}>Questions checked</span>
              <span className={styles.scMetricValue}>{latestSucceeded.questions.length}</span>
              <span className={styles.scMetricNote}>
                {relativeTime(latestSucceeded.createdAt)}
              </span>
            </div>
          </div>

          {latest && latest.id !== latestSucceeded.id && (latest.status === "running" || latest.status === "queued") && (
            <p className={styles.resultsMeta}>A newer check is running now; these are the last completed results.</p>
          )}
          {providerErrors.length > 0 && latest?.id === latestSucceeded.id && (
            providerErrors.map(([provider, message]) => (
              <p key={provider} className={styles.resultsError}>
                <strong>{aiVisibilityProviderLabel(provider)}: </strong>
                <LinkifiedText text={message as string} />
              </p>
            ))
          )}

          {/* Requirement 4: grouped by buyer question, not by provider. */}
          <div className={styles.resultsRowHead}>
            <h3>Questions tracked</h3>
            <button type="button" className={styles.textButton} onClick={() => setManagingQuestions(true)}>
              Manage questions
            </button>
          </div>
          <div className={styles.resultsList}>
            {grouped.map((item) => (
              <TrackedQuestionRow key={item.question} grouped={item} onOpen={() => setOpenQuestion(item.question)} />
            ))}
          </div>
        </div>
      )}

      {openGrouped && latestSucceeded && (
        <AiVisibilityAnswerDrawer
          grouped={openGrouped}
          checkedAt={latestSucceeded.createdAt}
          onClose={() => setOpenQuestion(null)}
        />
      )}

      {managingQuestions && (
        <ManageQuestionsPanel
          questions={status.questions ?? []}
          onSave={saveQuestions}
          onClose={() => setManagingQuestions(false)}
        />
      )}
    </section>
  );
}

type IconName =
  | "arrow"
  | "arrowLeft"
  | "check"
  | "copy"
  | "decline"
  | "edit"
  | "external"
  | "logo"
  | "refresh"
  | "replied"
  | "star";

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  if (name === "logo") {
    return (
      <img
        src="/logos/scooptr-mark.png"
        alt=""
        style={{ height: size, width: "auto", display: "inline-block", flexShrink: 0 }}
      />
    );
  }
  const glyphs: Record<Exclude<IconName, "logo">, string> = {
    arrow: "\u2192",
    arrowLeft: "\u2190",
    check: "\u2713",
    copy: "\u29c9",
    decline: "\u2715",
    edit: "\u270e",
    external: "\u2197",
    refresh: "\u21bb",
    replied: "\u21a9",
    star: "\u2605",
  };

  return (
    <span
      className={styles.glyph}
      style={{ fontSize: Math.max(11, size - 2) }}
      aria-hidden="true"
    >
      {glyphs[name]}
    </span>
  );
}

function potentialIntentLabel(intent: RedditOpportunity["potentialCustomerIntent"]) {
  if (intent === "high_intent") return "Actively looking";
  if (intent === "competitor_switching") return "Frustrated with an alternative";
  if (intent === "problem_aware") return "Problem aware";
  return "Relevant demand signal";
}

function relativeTime(value: string | undefined): string {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) return "Recently";
  const elapsed = Math.max(0, Date.now() - timestamp);
  const hours = Math.floor(elapsed / 3_600_000);
  if (hours < 1) return "Less than an hour ago";
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function TrackedSection({
  event,
  onView,
  children,
}: {
  event: FunnelEventName;
  onView?: (name: FunnelEventName) => Promise<void> | void;
  children: React.ReactNode;
}) {
  const target = useRef<HTMLDivElement | null>(null);
  const recorded = useRef(false);

  useEffect(() => {
    const element = target.current;
    if (!element || recorded.current || !onView) return;
    const record = () => {
      if (recorded.current) return;
      recorded.current = true;
      void onView(event);
    };
    if (!("IntersectionObserver" in window)) {
      record();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          record();
          observer.disconnect();
        }
      },
      { threshold: 0.25 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [event, onView]);

  return <div ref={target}>{children}</div>;
}

async function copyBrowserText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Insecure HTTP test hosts may not expose the modern Clipboard API.
  }
  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  return copied;
}

export function MockProviderNotice({
  label,
  disclosure,
  compact = false,
}: {
  label: string;
  disclosure: string;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <details className={styles.demoNoticeCompact}>
        <summary>
          <span className={styles.demoNoticeDot} />
          <strong>{label}</strong>
          <span>Source details</span>
        </summary>
        <p>{disclosure}</p>
      </details>
    );
  }
  return (
    <div className={styles.demoNotice}>
      <span className={styles.demoNoticeDot} />
      <div>
        <strong>{label}</strong>
        <p>{disclosure}</p>
      </div>
    </div>
  );
}

export function BusinessProfilePanel({
  profile,
}: {
  profile: BusinessProfile;
}) {
  const audiences = profile.targetAudience.length
    ? profile.targetAudience
    : ["Not confidently identified from the public pages checked"];
  const problems = profile.problemsSolved.length
    ? profile.problemsSolved
    : ["Not confidently identified from the public pages checked"];
  const features = profile.features.length
    ? profile.features
    : ["No product feature was confidently verified"];

  return (
    <section className={`${styles.card} ${styles.profileCard}`}>
      <div className={styles.sectionHeadingRow}>
        <div>
          <span className={styles.eyebrow}>Business understanding</span>
          <h2>We understand what {profile.name} does</h2>
        </div>
        <span className={styles.sourcePill}>
          <Icon name="check" size={14} />
          {profile.analyzedPageCount} public pages checked
        </span>
      </div>
      <p className={styles.profileSummary}>{profile.oneLineSummary}</p>

      <div className={styles.profileGrid}>
        <div>
          <span className={styles.fieldLabel}>Best-fit audience</span>
          <ul className={styles.cleanList}>
            {audiences.map((audience) => (
              <li key={audience}>
                <span className={styles.listDot} />
                {audience}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <span className={styles.fieldLabel}>Problems solved</span>
          <ul className={styles.cleanList}>
            {problems.map((problem) => (
              <li key={problem}>
                <span className={styles.listDot} />
                {problem}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className={styles.capabilityRow}>
        {features.map((feature) => (
          <span key={feature} className={styles.capabilityPill}>
            {feature}
          </span>
        ))}
      </div>
      <p className={styles.provenanceFootnote}>
        <Icon name="check" size={13} />{" "}
        {profile.isFictionalDemoBusiness
          ? "Facts and reply claims map back to the labeled demo website snapshot. The business is fictional."
          : "Facts and reply claims map back to the submitted public website pages; uncertain fields are stated explicitly."}
      </p>
    </section>
  );
}

export function OpportunityCard({
  opportunity,
  onOpenReply,
}: {
  opportunity: RedditOpportunity;
  onOpenReply?: (opportunityId: string) => void;
}) {
  return (
    <article className={styles.opportunityCard}>
      <div className={styles.opportunityTopline}>
        <div className={styles.sourceIdentity}>
          <span className={styles.redditMark}>u/</span>
          <div>
            <strong>{opportunity.authorLabel.replace(/^u\//i, "")}</strong>
            <span>
              {relativeTime(opportunity.sourceCreatedAt ?? opportunity.capturedAt)} · {opportunity.subreddit} · Public {opportunity.conversationType}
            </span>
          </div>
        </div>
        <span
          className={`${styles.intentPill} ${
            opportunity.classification.buyerIntent === "high"
              ? styles.intentHigh
              : styles.intentMedium
          }`}
        >
          {potentialIntentLabel(opportunity.potentialCustomerIntent)}
        </span>
      </div>

      <h3>{opportunity.title}</h3>
      <div className={styles.mockExcerpt}>
        <span>{opportunity.isMock ? "Mock conversation excerpt" : "Public conversation excerpt"}</span>
        <p>“{opportunity.excerpt}”</p>
      </div>

      <div className={styles.opportunityMeta}>
        <span>
          <b>{opportunity.supportingSignalCount ?? 1}</b> supporting signal{(opportunity.supportingSignalCount ?? 1) === 1 ? "" : "s"}
        </span>
        <span>
          <b>{opportunity.classification.communityRisk}</b> community risk
        </span>
      </div>

      <div className={styles.fitReasonGrid}>
        <div>
          <span className={styles.fieldLabel}>Why this person may be relevant</span>
          <p>{opportunity.matchReasons[0] ?? opportunity.classification.customerProblem}</p>
        </div>
        <div>
          <span className={styles.fieldLabel}>Why the business fits</span>
          <p>{opportunity.matchReasons[1] ?? opportunity.classification.customerProblem}</p>
        </div>
      </div>

      <div className={styles.opportunityAction}>
        <div>
          <span className={styles.fieldLabel}>Suggested reply</span>
          <p>{opportunity.reply.draft ? "Ready to review and edit" : "Not prepared"}</p>
        </div>
        <div className={styles.opportunityButtons}>
          {opportunity.permalink && !opportunity.isMock && (
            <a
              className={styles.secondaryButton}
              href={opportunity.permalink}
              target="_blank"
              rel="noreferrer"
            >
              View on Reddit <Icon name="external" size={14} />
            </a>
          )}
          {onOpenReply && (
            <button
              className={styles.secondaryButton}
              type="button"
              onClick={() => onOpenReply(opportunity.id)}
            >
              Suggested reply ready <Icon name="arrow" size={15} />
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function intelligenceLabel(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function RelevantConversationCard({
  conversation,
}: {
  conversation: RelevantConversation;
}) {
  const [showReply, setShowReply] = useState(false);
  const signalLabels = [...new Set([
    ...conversation.demandSignals,
    ...conversation.tags,
  ])].slice(0, 5);
  const hasReply = Boolean(conversation.reply?.draft.trim());

  return (
    <article className={styles.opportunityCard}>
      <div className={styles.opportunityTopline}>
        <div className={styles.sourceIdentity}>
          <span className={styles.redditMark}>r/</span>
          <div>
            <strong>{conversation.authorLabel.replace(/^u\//i, "")}</strong>
            <span>
              {relativeTime(conversation.capturedAt)} · {conversation.subreddit} · Public conversation
            </span>
          </div>
        </div>
        <span className={`${styles.intentPill} ${styles.intentMedium}`}>
          Research signal — not a lead
        </span>
      </div>

      <h3>{conversation.title}</h3>
      <div className={styles.mockExcerpt}>
        <span>Why it matters</span>
        <p>{conversation.summary}</p>
      </div>
      {signalLabels.length > 0 && (
        <div className={styles.opportunityMeta}>
          {signalLabels.map((signal) => (
            <span key={signal}>{intelligenceLabel(signal)}</span>
          ))}
          {conversation.competitorName && (
            <span>Competitor: {conversation.competitorName}</span>
          )}
        </div>
      )}
      {hasReply && showReply && (
        <div className={styles.mockExcerpt}>
          <span>Suggested reply</span>
          <p>{conversation.reply?.draft}</p>
        </div>
      )}
      <div className={styles.opportunityAction}>
        <div>
          <span className={styles.fieldLabel}>Recommended use</span>
          <p>
            {hasReply
              ? "Use this source to understand demand, objections or alternatives. It is not counted as a potential customer, but a reply-suitable draft is available below."
              : "Use this source to understand demand, objections or alternatives. It is not counted as a potential customer and has no generated reply."}
          </p>
        </div>
        <div className={styles.opportunityButtons}>
          {conversation.permalink && !conversation.isMock && (
            <a
              className={styles.secondaryButton}
              href={conversation.permalink}
              target="_blank"
              rel="noreferrer noopener"
            >
              View Reddit conversation <Icon name="external" size={14} />
            </a>
          )}
          {hasReply && (
            <button
              className={styles.secondaryButton}
              type="button"
              onClick={() => setShowReply((value) => !value)}
            >
              {showReply ? "Hide suggested reply" : "Suggested reply ready"} <Icon name="arrow" size={15} />
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

/**
 * The carousel's single-card presentation of a RelevantConversation --
 * mirrors CarouselOpportunityCard's topline (reliability badge, "Most
 * reliable" star) so a relevant-but-not-lead conversation reads as one more
 * card in the same swipeable browser, not a visually distinct fallback.
 * Actions stay conversation's own (a static pre-drafted reply revealed
 * in-card), not the full generate/edit/publish flow opportunities get.
 */
function CarouselRelevantCard({
  conversation,
  isRevealed,
  onToggleReply,
  createdDraft,
  isCreatingReply,
  onCreateReply,
  reviewStatus,
  onSetReviewStatus,
  reliability,
}: {
  conversation: RelevantConversation;
  isRevealed: boolean;
  onToggleReply: () => void;
  /** A reply drafted on demand this session via "Create reply" -- kept in
   * the parent's local state rather than the report, since it exists purely
   * client-side until the user copies or publishes it. */
  createdDraft?: string;
  isCreatingReply: boolean;
  onCreateReply: () => void;
  reviewStatus: "reviewed" | "declined" | "replied" | null;
  onSetReviewStatus: (status: "reviewed" | "declined" | "replied") => void;
  reliability: number;
}) {
  const signalLabels = [...new Set([
    ...conversation.demandSignals,
    ...conversation.tags,
  ])].slice(0, 5);
  const draft = conversation.reply?.draft ?? createdDraft;
  const hasReply = Boolean(draft?.trim());

  return (
    <article className={styles.opportunityCard}>
      <div className={styles.opportunityTopline}>
        <div className={styles.sourceIdentity}>
          <span className={styles.redditMark}>r/</span>
          <div>
            <strong>{conversation.authorLabel.replace(/^u\//i, "")}</strong>
            <span>
              {relativeTime(conversation.capturedAt)} &middot; {conversation.subreddit} &middot; Public conversation
            </span>
          </div>
          <ReviewStatusBadge status={reviewStatus} />
        </div>
      </div>

      <RelevanceBadge score={reliability} />

      <h3>{conversation.title}</h3>
      <div className={styles.mockExcerpt}>
        <span>Why it matters</span>
        <p>{conversation.summary}</p>
      </div>
      {signalLabels.length > 0 && (
        <div className={styles.opportunityMeta}>
          {signalLabels.map((signal) => (
            <span key={signal}>{intelligenceLabel(signal)}</span>
          ))}
          {conversation.competitorName && (
            <span>Competitor: {conversation.competitorName}</span>
          )}
        </div>
      )}
      {hasReply && isRevealed && (
        <div className={styles.mockExcerpt}>
          <span>Suggested reply</span>
          <p>{draft}</p>
        </div>
      )}

      <div className={styles.carouselActions}>
        {hasReply ? (
          <button className={styles.primaryButton} type="button" onClick={onToggleReply}>
            <Icon name="refresh" size={14} />
            {isRevealed ? "Hide suggested reply" : "Suggested reply ready"}
          </button>
        ) : (
          <button
            className={styles.primaryButton}
            type="button"
            disabled={isCreatingReply}
            onClick={onCreateReply}
          >
            <Icon name="refresh" size={14} />
            {isCreatingReply ? "Creating reply…" : "Create reply"}
          </button>
        )}
        {conversation.permalink && !conversation.isMock && (
          <a
            className={styles.secondaryButton}
            href={conversation.permalink}
            target="_blank"
            rel="noreferrer noopener"
          >
            View Reddit conversation <Icon name="external" size={14} />
          </a>
        )}
      </div>
      <ReviewActionsRow status={reviewStatus} onSetStatus={onSetReviewStatus} />
    </article>
  );
}

type InsightsFilter = "all" | "pains" | "requests" | "patterns";

/**
 * Compact segmented filter for the Insights screen, above the three
 * existing sections (Pains/Requests/Demand patterns). Reuses the exact
 * same classes as the carousel's ReviewFilterTabs -- same segmented-
 * control visual language across the app rather than a second one
 * invented for this screen. Purely a display filter: it hides/shows
 * existing sections, never touches what data was fetched or generated.
 */
function InsightsFilterTabs({
  filter,
  onFilterChange,
  counts,
}: {
  filter: InsightsFilter;
  onFilterChange: (filter: InsightsFilter) => void;
  counts: Record<InsightsFilter, number>;
}) {
  const tabs: Array<{ id: InsightsFilter; label: string }> = [
    { id: "all", label: "All" },
    { id: "pains", label: "Pains" },
    { id: "requests", label: "Requests" },
    { id: "patterns", label: "Demand patterns" },
  ];
  return (
    <div className={styles.reviewFilterTabs} role="tablist" aria-label="Filter insights by type">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={filter === tab.id}
          className={`${styles.reviewFilterTab} ${filter === tab.id ? styles.reviewFilterTabActive : ""}`}
          onClick={() => onFilterChange(tab.id)}
        >
          {tab.label} <span className={styles.reviewFilterCount}>{counts[tab.id]}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * A demand-pattern insight, restyled to match ThemeSection's card
 * language (same .themeCard/.themeToggle/.themeEvidence classes) so
 * Pains, Requests, and Demand patterns read as one consistent card
 * system instead of two different ones on the same screen -- no new
 * CSS was needed for the card shell itself.
 *
 * Two real, existing fields this card newly surfaces: insight.evidence
 * (populated since the API response, but never rendered anywhere in the
 * UI before this) behind the same collapsed-by-default toggle
 * ThemeSection already uses, and a sourceCount-based sort at the call
 * site (see the .sort() below) so stronger patterns lead.
 *
 * Deliberately drops insight.recommendedAction: every one of these
 * insights carries the exact same static sentence ("Use the underlying
 * question to guide a useful answer and product messaging."), never
 * anything specific to that insight -- displaying it added no unique
 * information per card, which is exactly the repeated boilerplate this
 * screen was asked to remove. whyItMatters is also skipped for the same
 * reason: it is set to the same string as summary at the data-adapter
 * level (see from-scan.ts), so showing both would just repeat one
 * sentence twice.
 */
function DemandPatternCard({ insight }: { insight: DemandInsight }) {
  const [open, setOpen] = useState(false);
  return (
    <article className={styles.themeCard}>
      <span className={styles.simpleCardEyebrow}>{insight.eyebrow}</span>
      <div className={styles.themeHead}>
        <h3>{insight.title}</h3>
      </div>
      <p className={styles.simpleCardBody}>{insight.summary}</p>
      {insight.evidence.length > 0 && (
        <>
          <button
            className={styles.themeToggle}
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? "Hide evidence" : "View evidence"}
          </button>
          {open && (
            <ul className={styles.themeEvidence}>
              {insight.evidence.map((item) => (
                <li key={item.provenanceId}>
                  <span>{item.quote}</span>
                  {item.sourceUrl && (
                    <a href={item.sourceUrl} target="_blank" rel="noreferrer noopener">
                      {item.sourceLabel}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </article>
  );
}

/**
 * A recurring struggle or request, with its supporting conversations behind a
 * "Show evidence" toggle.
 *
 * Every aggregated count in the report has to be inspectable: the number shown
 * is the number of conversations listed, so a reader can always check the claim
 * rather than trust it.
 */
function ThemeSection({
  kind,
  eyebrow,
  heading,
  themes,
}: {
  kind: "struggle" | "request";
  eyebrow: string;
  heading: string;
  themes: ConversationTheme[];
}) {
  const [openThemeId, setOpenThemeId] = useState<string | null>(null);
  const visible = (themes ?? []).filter((theme) => theme.kind === kind);
  if (visible.length === 0) return null;

  return (
    <section className={styles.dashboardSection}>
      <div className={styles.sectionHeadingRow}>
        <div>
          <span className={styles.eyebrow}>{eyebrow}</span>
          <h2>{heading}</h2>
        </div>
      </div>
      <div className={styles.insightColumn}>
        {visible.map((theme) => {
          const open = openThemeId === theme.id;
          return (
            <article className={styles.themeCard} key={theme.id}>
              <div className={styles.themeHead}>
                <h3>{theme.label}</h3>
                <span className={styles.themeCount}>
                  {theme.conversationCount} conversation
                  {theme.conversationCount === 1 ? "" : "s"}
                </span>
              </div>
              <button
                className={styles.themeToggle}
                type="button"
                aria-expanded={open}
                onClick={() => setOpenThemeId(open ? null : theme.id)}
              >
                {open ? "Hide evidence" : "Show evidence"}
              </button>
              {open && (
                <ul className={styles.themeEvidence}>
                  {theme.evidence.map((item) => (
                    <li key={item.sourceId}>
                      {item.permalink ? (
                        <a href={item.permalink} target="_blank" rel="noreferrer noopener">
                          {item.title}
                        </a>
                      ) : (
                        <span>{item.title}</span>
                      )}
                      <em>r/{item.subreddit}</em>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ReplyComposer({
  opportunity,
  value,
  isEditing,
  isCopied,
  isPublished,
  onChange,
  onEdit,
  onRegenerate,
  onCopy,
  onPublish,
  redditConnection,
}: {
  opportunity: RedditOpportunity;
  value: string;
  isEditing: boolean;
  isCopied: boolean;
  isPublished: boolean;
  onChange: (value: string) => void;
  onEdit: () => void;
  onRegenerate: () => void;
  onCopy: () => void;
  onPublish: () => void;
  redditConnection: RedditConnectionStatus;
}) {
  const canPostDirectly = Boolean(
    redditConnection.connected && opportunity.canReplyOnReddit,
  );
  const hasManualTarget = Boolean(opportunity.permalink && !opportunity.isMock);
  const publishedOnReddit =
    isPublished && opportunity.reply.publishedVia === "reddit";

  return (
    <section className={`${styles.card} ${styles.replyComposer}`}>
      <div className={styles.replyHeader}>
        <div>
          <span className={styles.eyebrow}>Grounded suggested reply</span>
          <h2>
            {opportunity.disclosureRequired
              ? "Answer first. Be useful. Disclose the connection."
              : "Answer first. Be useful. Keep promotion out."}
          </h2>
        </div>
        <span className={styles.sourcePill}>
          <Icon name="check" size={14} />
          Grounded in verified website facts
        </span>
      </div>

      <div className={styles.replyContext}>
        <span>
          Replying to a {opportunity.isMock ? "mock" : "public"} conversation in{" "}
          {opportunity.subreddit}
        </span>
        <strong>{opportunity.title}</strong>
      </div>

      {isEditing ? (
        <textarea
          className={styles.replyTextarea}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label="Edit suggested reply"
          rows={12}
        />
      ) : (
        <div className={styles.replyPreview}>
          {value.split("\n\n").map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
      )}

      <div className={styles.replyGuardrails}>
        <span>
          <Icon name="check" size={13} /> Answers the question first
        </span>
        <span>
          <Icon name="check" size={13} /> Uses source-backed website facts only
        </span>
        {opportunity.disclosureRequired ? (
          <span>
            <Icon name="check" size={13} /> Includes required disclosure
          </span>
        ) : (
          <span>
            <Icon name="check" size={13} /> Keeps the product out unless it helps
          </span>
        )}
        <span>
          <Icon name="check" size={13} /> Makes no experience claim
        </span>
      </div>

      <div className={styles.replyActions}>
        <div>
          <button className={styles.textButton} type="button" onClick={onEdit}>
            <Icon name="edit" size={15} /> {isEditing ? "Preview" : "Edit"}
          </button>
          <button
            className={styles.textButton}
            type="button"
            onClick={onRegenerate}
          >
            <Icon name="refresh" size={15} /> Regenerate
          </button>
          <button className={styles.textButton} type="button" onClick={onCopy}>
            <Icon name={isCopied ? "check" : "copy"} size={15} />
            {isCopied ? "Copied" : "Copy"}
          </button>
        </div>
        <button
          className={styles.primaryButton}
          type="button"
          onClick={onPublish}
          disabled={isPublished || (!canPostDirectly && !hasManualTarget)}
        >
          {isPublished ? (
            <>
              <Icon name="check" size={15} />
              {publishedOnReddit ? "Posted to Reddit" : "Marked published"}
            </>
          ) : (
            <>
              {canPostDirectly ? "Post to Reddit" : "Copy & open Reddit"}
              <Icon name="external" size={14} />
            </>
          )}
        </button>
      </div>
      <p className={styles.replyPublishNote}>
        {canPostDirectly
          ? `Posts as u/${redditConnection.username} after your final review.`
          : hasManualTarget
            ? "Copies your edited reply and opens the exact Reddit conversation; nothing is posted automatically."
            : "This result has no verified live Reddit destination, so publishing is disabled."}
      </p>
      {isPublished && opportunity.reply.publishedUrl && (
        <a
          className={styles.publishedReplyLink}
          href={opportunity.reply.publishedUrl}
          target="_blank"
          rel="noreferrer"
        >
          View posted reply on Reddit <Icon name="external" size={13} />
        </a>
      )}
    </section>
  );
}

/**
 * Built entirely from the same classification fields the ranking and reply
 * pipeline already produce (buyerIntent, conversationType, communityRisk,
 * competitorComplaint, potentialCustomerIntent) -- no new signal data is
 * introduced, these are just formatted as a compact chip row instead of the
 * full sentences shown elsewhere on the card.
 */
function reliabilitySignalTags(opportunity: RedditOpportunity): string[] {
  const tags: string[] = [];
  if (opportunity.potentialCustomerIntent) {
    tags.push(potentialIntentLabel(opportunity.potentialCustomerIntent));
  }
  tags.push(`${intelligenceLabel(opportunity.classification.buyerIntent)} intent`);
  tags.push(intelligenceLabel(opportunity.conversationType));
  if (opportunity.classification.competitorComplaint) {
    tags.push("Competitor complaint");
  }
  tags.push(`${intelligenceLabel(opportunity.classification.communityRisk)} community risk`);
  return [...new Set(tags)].slice(0, 5);
}

/**
 * Shared by both carousel card kinds -- three compact toggle buttons for
 * the person's own manual triage mark. Clicking the already-active one
 * undoes it (clears back to untouched); clicking a different one switches
 * directly. Deliberately just three small buttons next to the existing
 * footer actions, not a separate toolbar.
 */
function ReviewActionsRow({
  status,
  onSetStatus,
}: {
  status: "reviewed" | "declined" | "replied" | null;
  onSetStatus: (status: "reviewed" | "declined" | "replied") => void;
}) {
  return (
    <div className={styles.reviewActions} role="group" aria-label="Mark this conversation">
      <button
        type="button"
        className={`${styles.reviewActionButton} ${status === "declined" ? styles.reviewActionActive : ""}`}
        aria-pressed={status === "declined"}
        onClick={() => onSetStatus("declined")}
      >
        <Icon name="decline" size={12} /> Not relevant
      </button>
      <button
        type="button"
        className={`${styles.reviewActionButton} ${status === "reviewed" ? styles.reviewActionActive : ""}`}
        aria-pressed={status === "reviewed"}
        onClick={() => onSetStatus("reviewed")}
      >
        <Icon name="check" size={12} /> Reviewed
      </button>
      <button
        type="button"
        className={`${styles.reviewActionButton} ${status === "replied" ? styles.reviewActionActive : ""}`}
        aria-pressed={status === "replied"}
        onClick={() => onSetStatus("replied")}
      >
        <Icon name="replied" size={12} /> Replied
      </button>
    </div>
  );
}

/** The subtle top-of-card indicator for whichever status is currently set -- absent entirely when untouched. */
function ReviewStatusBadge({ status }: { status: "reviewed" | "declined" | "replied" | null }) {
  if (!status) return null;
  const label = status === "declined" ? "Not relevant" : status === "reviewed" ? "Reviewed" : "Replied";
  const toneClass =
    status === "declined" ? styles.reviewStatusDeclined
      : status === "reviewed" ? styles.reviewStatusReviewed
        : styles.reviewStatusReplied;
  return <span className={`${styles.reviewStatusBadge} ${toneClass}`}>{label}</span>;
}

/**
 * The existing 0-100 ranking score every opportunity/relevant conversation
 * already carries (CarouselItem.reliability -- opportunity.classification.
 * relevanceScore or conversation.reliabilityScore, both already clamped
 * 0-100 server-side; see percent() in reddit-pipeline.ts and
 * publicRelevantConversation's Math.round/clamp in presenter.ts). This is
 * the same number that already decides carousel order -- displayed here,
 * not recomputed. "High relevance" is a single, transparent threshold on
 * that existing number (>= 85), not a new scoring system or a multi-tier
 * legend; below that, just the number.
 */
function RelevanceBadge({ score }: { score: number }) {
  const rounded = Math.round(Math.max(0, Math.min(100, score)));
  return (
    <span className={styles.relevanceBadge}>
      <strong>{rounded}</strong>
      <span>{rounded >= 85 ? "High relevance" : "relevance"}</span>
    </span>
  );
}

/**
 * The single card shown by OpportunityCarousel. Same underlying fields as
 * OpportunityCard (relevanceScore, matchReasons, permalink, reply) -- this
 * is a presentation variant for the single-card carousel, not a new data
 * shape.
 */
function CarouselOpportunityCard({
  opportunity,
  currentDraft,
  isRevealed,
  onToggleReply,
  isCreatingReply,
  onCreateReply,
  reviewStatus,
  onSetReviewStatus,
  reliability,
}: {
  opportunity: RedditOpportunity;
  /** drafts[opportunity.id] from the parent if a reply has already been
   * generated on demand this session, else undefined -- opportunity.reply.draft
   * itself starts empty for every opportunity now (see scan-workflow.ts:
   * reply generation is on-demand only, never automatic during a scan). */
  currentDraft: string | undefined;
  isRevealed: boolean;
  onToggleReply: () => void;
  isCreatingReply: boolean;
  onCreateReply: () => void;
  reviewStatus: "reviewed" | "declined" | "replied" | null;
  onSetReviewStatus: (status: "reviewed" | "declined" | "replied") => void;
  reliability: number;
}) {
  const tags = reliabilitySignalTags(opportunity);
  const whyItMatters = opportunity.matchReasons[0] ?? opportunity.classification.customerProblem;
  const hasReply = Boolean((currentDraft ?? opportunity.reply.draft)?.trim());

  return (
    <article className={styles.opportunityCard}>
      <div className={styles.sourceIdentity}>
        <span className={styles.redditMark}>u/</span>
        <div>
          <strong>{opportunity.authorLabel.replace(/^u\//i, "")}</strong>
          <span>
            {opportunity.subreddit} &middot;{" "}
            {relativeTime(opportunity.sourceCreatedAt ?? opportunity.capturedAt)} &middot; Public{" "}
            {opportunity.conversationType}
          </span>
        </div>
        <ReviewStatusBadge status={reviewStatus} />
      </div>

      <RelevanceBadge score={reliability} />

      <h3>{opportunity.title}</h3>

      <div className={styles.mockExcerpt}>
        <span>Why it matters</span>
        <p>{whyItMatters}</p>
      </div>

      {tags.length > 0 && (
        <div className={styles.opportunityMeta}>
          {tags.map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </div>
      )}

      <div className={styles.carouselActions}>
        {hasReply ? (
          <button className={styles.primaryButton} type="button" onClick={onToggleReply}>
            <Icon name="refresh" size={14} />
            {isRevealed ? "Hide reply" : "Suggested reply ready"}
          </button>
        ) : (
          <button
            className={styles.primaryButton}
            type="button"
            disabled={isCreatingReply}
            onClick={onCreateReply}
          >
            <Icon name="refresh" size={14} />
            {isCreatingReply ? "Generating reply…" : "Generate reply"}
          </button>
        )}
        {opportunity.permalink && !opportunity.isMock && (
          <a
            className={styles.secondaryButton}
            href={opportunity.permalink}
            target="_blank"
            rel="noreferrer"
          >
            View Reddit conversation <Icon name="external" size={14} />
          </a>
        )}
      </div>
      <ReviewActionsRow status={reviewStatus} onSetStatus={onSetReviewStatus} />
    </article>
  );
}

/**
 * A Tinder-style, single-card horizontal browser over the same
 * relevance-ranked opportunities list OpportunityCard used to render as a
 * stack. Ordering, reply generation and Reddit links are untouched -- only
 * one conversation is ever on screen at a time, and the user can move
 * freely in either direction with the arrow buttons, the dots, or the
 * left/right arrow keys.
 */
/**
 * One card of the unified carousel: either a qualified opportunity (lead) or
 * a relevant-but-not-lead conversation. Merging both into a single sorted
 * list is what lets "ordered by AI reliability, highest first" mean one
 * ranking axis across everything that passed filtering, instead of two
 * separately-ranked lists shown in two different places.
 */
/**
 * Reshapes a raw ScanEvidenceCandidate (everything the lightweight AI
 * shortlisted, whether or not it went on to a published lead or relevant
 * conversation) into a RelevantConversation so it renders through the exact
 * same carousel card. No reply is attached -- these never became a backend
 * opportunity/reply record, so there is a discovery signal to show but
 * nothing to generate or publish yet. Tags stay honest about how far this
 * particular candidate actually got in the pipeline.
 */
function candidateAsRelevantConversation(candidate: ScanEvidenceCandidate): RelevantConversation {
  const deep = candidate.deepQualification;
  const tags = [
    ...(deep?.intelligenceTags ?? []),
    deep ? "AI reviewed" : "Lightweight signal only",
    candidate.fullContextVerified ? "Full thread verified" : "Not yet verified",
  ];
  return {
    id: `evidence:${candidate.externalId}`,
    externalId: candidate.externalId,
    provider: "reddit",
    isMock: false,
    title: candidate.title || "Reddit comment",
    summary: deep?.whyItMatters || candidate.triage.reason || candidate.excerpt,
    subreddit: candidate.subreddit,
    authorLabel: candidate.author ?? "Reddit user",
    capturedAt: candidate.sourceCreatedAt,
    permalink: candidate.permalink,
    tags,
    demandSignals: deep?.demandSignals ?? (candidate.triage.demandSignal ? [candidate.triage.demandSignal] : []),
    competitorName: null,
    provenanceIds: [],
    reliabilityScore: candidate.reliabilityScore,
  };
}

type CarouselItem =
  | { kind: "opportunity"; id: string; reliability: number; opportunity: RedditOpportunity }
  | { kind: "relevant"; id: string; reliability: number; conversation: RelevantConversation };

type ReviewFilter = "new" | "reviewed" | "replied" | "declined" | "all";

const REVIEW_FILTER_TABS: Array<{ id: ReviewFilter; label: string }> = [
  { id: "new", label: "New" },
  { id: "reviewed", label: "Reviewed" },
  { id: "replied", label: "Replied" },
  { id: "declined", label: "Declined" },
  { id: "all", label: "All" },
];

function matchesReviewFilter(
  filter: ReviewFilter,
  status: "reviewed" | "declined" | "replied" | null,
): boolean {
  if (filter === "all") return true;
  if (filter === "new") return status === null;
  return status === filter;
}

/**
 * Compact segmented filter shown directly above the carousel card. Counts
 * are derived from the same items/reviewMarks the carousel already has --
 * no new data source. Purely a view over existing state, same as the
 * carousel itself: this never touches ranking or which items exist.
 */
function ReviewFilterTabs({
  filter,
  onFilterChange,
  counts,
}: {
  filter: ReviewFilter;
  onFilterChange: (filter: ReviewFilter) => void;
  counts: Record<ReviewFilter, number>;
}) {
  return (
    <div className={styles.reviewFilterTabs} role="tablist" aria-label="Filter by review status">
      {REVIEW_FILTER_TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={filter === tab.id}
          className={`${styles.reviewFilterTab} ${filter === tab.id ? styles.reviewFilterTabActive : ""}`}
          onClick={() => onFilterChange(tab.id)}
        >
          {tab.label} <span className={styles.reviewFilterCount}>{counts[tab.id]}</span>
        </button>
      ))}
    </div>
  );
}

function OpportunityCarousel({
  items,
  drafts,
  editingReplyId,
  copiedReplyId,
  publishedOpportunityIds,
  onDraftChange,
  onToggleEdit,
  onRegenerate,
  onCopy,
  onPublish,
  redditConnection,
  onFunnelEvent,
  createdReplies,
  creatingReplyId,
  onCreateReply,
  reviewMarks,
  onSetReviewMark,
}: {
  items: CarouselItem[];
  drafts: Record<string, string>;
  editingReplyId: string | null;
  copiedReplyId: string | null;
  publishedOpportunityIds: string[];
  onDraftChange: (opportunityId: string, value: string) => void;
  onToggleEdit: (opportunityId: string) => void;
  onRegenerate: (opportunity: RedditOpportunity) => Promise<void>;
  onCopy: (opportunityId: string) => void;
  onPublish: (opportunity: RedditOpportunity) => void;
  redditConnection: RedditConnectionStatus;
  onFunnelEvent?: (name: FunnelEventName) => Promise<void> | void;
  createdReplies: Record<string, string>;
  creatingReplyId: string | null;
  onCreateReply: (conversation: RelevantConversation) => void;
  reviewMarks: Record<string, "reviewed" | "declined" | "replied">;
  onSetReviewMark: (itemId: string, status: "reviewed" | "declined" | "replied" | null) => void;
}) {
  const [index, setIndex] = useState(0);
  const [revealedReplyIds, setRevealedReplyIds] = useState<Set<string>>(new Set());
  // Only one card is ever on screen at a time in this Tinder-style
  // carousel, so a single id (not a Set) is enough to track which
  // opportunity's on-demand "Generate reply" call is in flight.
  const [generatingOpportunityId, setGeneratingOpportunityId] = useState<string | null>(null);
  const handleCreateOpportunityReply = async (opportunity: RedditOpportunity) => {
    if (generatingOpportunityId) return;
    setGeneratingOpportunityId(opportunity.id);
    try {
      await onRegenerate(opportunity);
    } finally {
      setGeneratingOpportunityId((current) => (current === opportunity.id ? null : current));
    }
  };
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("new");
  // Tracks which filter `index` currently applies to, so a filter change
  // can reset the position back to the first matching conversation. Set
  // directly during render (React's documented pattern for "adjusting
  // state when a prop/dependency changes") rather than in a useEffect,
  // which would cause an extra, avoidable re-render pass for this.
  const [indexFilter, setIndexFilter] = useState<ReviewFilter>(reviewFilter);
  if (reviewFilter !== indexFilter) {
    setIndexFilter(reviewFilter);
    setIndex(0);
  }

  // Counts always come from the full, unfiltered items list -- switching
  // tabs must never change what a count means. Relevance ordering (items
  // is already sorted strongest-first, see carouselItems above) is
  // preserved by filtering rather than re-sorting.
  const counts = useMemo(() => {
    const result: Record<ReviewFilter, number> = { new: 0, reviewed: 0, replied: 0, declined: 0, all: items.length };
    for (const candidate of items) {
      const status = reviewMarks[candidate.id] ?? null;
      if (status === null) result.new += 1;
      else result[status] += 1;
    }
    return result;
  }, [items, reviewMarks]);

  const filteredItems = useMemo(
    () => items.filter((candidate) => matchesReviewFilter(reviewFilter, reviewMarks[candidate.id] ?? null)),
    [items, reviewFilter, reviewMarks],
  );
  const total = filteredItems.length;

  // Derived rather than stored: if the underlying list ever changes size
  // (e.g. a fresh scan result swaps in a shorter list) the position clamps
  // back into range on the next render without a setState-in-effect, and
  // without touching the list or its order.
  const safeIndex = total === 0 ? 0 : Math.min(index, total - 1);
  const item = filteredItems[safeIndex];

  const goTo = (nextIndex: number) => setIndex(((nextIndex % total) + total) % total);
  const toggleReply = (itemId: string) => {
    setRevealedReplyIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const filterTabs = (
    <ReviewFilterTabs filter={reviewFilter} onFilterChange={setReviewFilter} counts={counts} />
  );

  if (!item) {
    const emptyLabel = reviewFilter === "all" ? "opportunities"
      : reviewFilter === "new" ? "new"
        : REVIEW_FILTER_TABS.find((tab) => tab.id === reviewFilter)?.label.toLowerCase();
    return (
      <div className={styles.carousel}>
        {filterTabs}
        <p className={styles.carouselEmptyFilter}>No {emptyLabel} conversations yet.</p>
      </div>
    );
  }

  const isRevealed = revealedReplyIds.has(item.id);
  const currentReviewStatus = reviewMarks[item.id] ?? null;
  // Toggling the already-active status off is the undo gesture; picking a
  // different one switches directly, with no separate "are you sure." No
  // explicit index change is needed here: under a specific filter, the
  // item disappearing from filteredItems on the next render naturally
  // leaves this same index pointing at what's now next (removing element N
  // shifts N+1 into its place) -- and under "All", filteredItems never
  // shrinks at all, so the same card just shows its updated status.
  const handleSetReviewStatus = (status: "reviewed" | "declined" | "replied") => {
    const next = currentReviewStatus === status ? null : status;
    onSetReviewMark(item.id, next);
  };

  return (
    <div
      className={styles.carousel}
      role="group"
      aria-roledescription="carousel"
      aria-label="Reddit posts found, ordered by AI reliability, highest first"
    >
      {filterTabs}
      {item.kind === "opportunity" ? (
        <CarouselOpportunityCard
          opportunity={item.opportunity}
          currentDraft={drafts[item.opportunity.id]}
          isRevealed={isRevealed}
          onToggleReply={() => toggleReply(item.id)}
          isCreatingReply={generatingOpportunityId === item.opportunity.id}
          onCreateReply={() => void handleCreateOpportunityReply(item.opportunity)}
          reviewStatus={currentReviewStatus}
          onSetReviewStatus={handleSetReviewStatus}
          reliability={item.reliability}
        />
      ) : (
        <CarouselRelevantCard
          conversation={item.conversation}
          isRevealed={isRevealed}
          onToggleReply={() => toggleReply(item.id)}
          createdDraft={createdReplies[item.conversation.id]}
          isCreatingReply={creatingReplyId === item.conversation.id}
          onCreateReply={() => onCreateReply(item.conversation)}
          reviewStatus={currentReviewStatus}
          onSetReviewStatus={handleSetReviewStatus}
          reliability={item.reliability}
        />
      )}

      {isRevealed && item.kind === "opportunity" && (
        <TrackedSection event="suggested_reply_viewed" onView={onFunnelEvent}>
          <ReplyComposer
            opportunity={item.opportunity}
            value={drafts[item.opportunity.id] ?? item.opportunity.reply.draft}
            isEditing={editingReplyId === item.opportunity.id}
            isCopied={copiedReplyId === item.opportunity.id}
            isPublished={publishedOpportunityIds.includes(item.opportunity.id)}
            onChange={(value) => onDraftChange(item.opportunity.id, value)}
            onEdit={() => onToggleEdit(item.opportunity.id)}
            onRegenerate={() => onRegenerate(item.opportunity)}
            onCopy={() => onCopy(item.opportunity.id)}
            onPublish={() => onPublish(item.opportunity)}
            redditConnection={redditConnection}
          />
        </TrackedSection>
      )}

      <div className={styles.carouselNav}>
        <button
          type="button"
          className={styles.carouselArrow}
          onClick={() => goTo(safeIndex - 1)}
          aria-label="Previous conversation"
        >
          <Icon name="arrowLeft" size={20} />
        </button>
        <span className={styles.carouselPosition}>
          {safeIndex + 1} of {total}
        </span>
        <button
          type="button"
          className={styles.carouselArrow}
          onClick={() => goTo(safeIndex + 1)}
          aria-label="Next conversation"
        >
          <Icon name="arrow" size={20} />
        </button>
      </div>
    </div>
  );
}

export function ProductDashboard({
  data: fixtureData = redditDemandDemoData,
  scanResult,
  analyzedDomain,
  initialSection,
  accessLevel = "free",
  onNewScan,
  onCheckout,
  onRegenerateReply,
  onPublishOpportunity,
  onSetReviewMark,
  redditConnection = {
    configured: false,
    connected: false,
    username: null,
    canConnect: false,
    requiresPaidAccess: true,
  },
  onConnectReddit,
  onDisconnectReddit,
  monitoring = null,
  onUpdateMonitoring,
  onUpdateBusinessSummary,
  monitorRuns = null,
  onViewMonitorRun,
  recommendedSubreddits = null,
  subredditPerformance = null,
  aiVisibility = null,
  onUpdateAiVisibility,
  visibilityScans = null,
  onCreateReply,
  onFunnelEvent,
}: ProductDashboardProps) {
  const data = scanResult ?? fixtureData;
  const [activeSection, setActiveSection] = useState<NavigationSectionId>(
    initialSection ?? "dashboard",
  );
  // Filters which of the three existing sections (Pains/Requests/Demand
  // patterns) render on the Insights screen -- purely a display filter over
  // data already loaded (data.conversationThemes, data.insights); it never
  // changes what was fetched, generated, or how it's ranked.
  const [insightsFilter, setInsightsFilter] = useState<"all" | "pains" | "requests" | "patterns">("all");
  // Opportunities and Competitors are the two screens that fill in on their
  // own as monitoring runs -- grouped under one collapsible "Inbox" header,
  // open by default. AI Citations/Live feed from the original design don't
  // exist yet (no pipeline behind them), so this stays a two-item group
  // rather than the full four-item one until those are real.
  const [inboxOpen, setInboxOpen] = useState(true);
  // Shown once per session over the Overview tab while no plan is active.
  // Deliberately does NOT claim the dashboard is empty -- the free scan's
  // real results are already shown here, which is true in this product
  // even before payment. What's actually off is ongoing monitoring, so
  // that's the honest premise (matches the sidebar's existing "Monitoring
  // is off" card copy, just with more room to make the case).
  const [valuePropDismissed, setValuePropDismissed] = useState(false);
  const relevantConversations = useMemo(() => data.relevantConversations ?? [], [data.relevantConversations]);
  const normalizedAnalyzedDomain = analyzedDomain
    ?.replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .toLowerCase();
  const isFixtureFallbackForSubmittedDomain = Boolean(
    analyzedDomain &&
      !scanResult &&
      normalizedAnalyzedDomain !== data.business.hostname.toLowerCase(),
  );
  const fixtureDisclosure = isFixtureFallbackForSubmittedDomain
    ? `${data.fixtureDisclosure} The facts below were not produced from ${analyzedDomain}; the labeled fixture is a clearly separated fallback while the real scan result is unavailable.`
    : data.fixtureDisclosure;
  const usesMockProvider =
    data.opportunities.some((opportunity) => opportunity.isMock) ||
    relevantConversations.some((conversation) => conversation.isMock);

  // Ranked once by the same deterministic relevance score the qualification
  // pipeline already computed, so "top 3" here matches what was actually
  // measured rather than display order.
  const rankedOpportunities = useMemo(
    () =>
      [...data.opportunities].sort(
        (a, b) => b.classification.relevanceScore - a.classification.relevanceScore,
      ),
    [data.opportunities],
  );
  const [editingReplyId, setEditingReplyId] = useState<string | null>(null);
  const [copiedReplyId, setCopiedReplyId] = useState<string | null>(null);
  const [publishedIds, setPublishedIds] = useState<string[]>([]);
  const [regenerationIndex, setRegenerationIndex] = useState<Record<string, number>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      data.opportunities.map((opportunity) => [opportunity.id, opportunity.reply.draft]),
    ),
  );

  // Optimistic overlay on top of data.reviewMarks (the server-persisted
  // map), same pattern as publishedIds above: applied immediately on click,
  // reconciled from the server on the next full data refresh. A stored
  // `null` here means "explicitly cleared this session" -- distinct from a
  // key simply being absent -- so an undo click that raced ahead of the
  // server's own copy of data.reviewMarks (e.g. this dashboard re-rendered
  // from a slightly stale fetch) can't be silently overridden back to the
  // previous status by the merge below.
  const [reviewMarkOverrides, setReviewMarkOverrides] = useState<
    Record<string, "reviewed" | "declined" | "replied" | null>
  >({});
  const reviewMarks = useMemo(() => {
    const merged: Record<string, "reviewed" | "declined" | "replied"> = { ...(data.reviewMarks ?? {}) };
    for (const [itemId, status] of Object.entries(reviewMarkOverrides)) {
      if (status === null) delete merged[itemId];
      else merged[itemId] = status;
    }
    return merged;
  }, [data.reviewMarks, reviewMarkOverrides]);
  const setReviewMark = async (itemId: string, status: "reviewed" | "declined" | "replied" | null) => {
    setReviewMarkOverrides((current) => ({ ...current, [itemId]: status }));
    const accepted = await onSetReviewMark?.(itemId, status);
    // A failed save keeps the optimistic value rather than reverting it --
    // matching this dashboard's other optimistic actions (e.g. publishReply
    // never rolls back on a false return either) -- a stray network blip
    // shouldn't visibly undo something the person just clicked. The next
    // full data refresh reconciles from the server either way.
    if (accepted === false) return;
  };

  const serverPublishedIds = useMemo(
    () =>
      data.opportunities
        .filter((opportunity) => opportunity.reply.status === "published")
        .map((opportunity) => opportunity.id),
    [data.opportunities],
  );
  const publishedOpportunityIds = useMemo(
    () => [...new Set([...serverPublishedIds, ...publishedIds])],
    [serverPublishedIds, publishedIds],
  );

  // Purely client-side: a reply drafted this session via "Create reply" for
  // a relevant conversation (or raw carousel candidate) that had none. Not
  // persisted into `data` -- the next fetched report will carry the real
  // stored version once the backend has it.
  const [createdReplies, setCreatedReplies] = useState<Record<string, string>>({});
  const [creatingReplyId, setCreatingReplyId] = useState<string | null>(null);
  const [disconnectingReddit, setDisconnectingReddit] = useState(false);

  // The Replies tab previously only read `rankedOpportunities` (server-
  // persisted opportunities), so a reply generated this session via
  // "Create reply" on a relevant-but-not-yet-an-opportunity conversation
  // never appeared there or counted toward "drafted" -- it only lives in
  // `createdReplies`, keyed by conversation id, until the next full data
  // refetch. Build lightweight display cards for those so they show up
  // immediately, without waiting on a refetch.
  //
  // Deliberately reads from `carouselItems` (defined below), not the raw
  // `relevantConversations` variable: the carousel's "relevant" items are
  // relevantConversations PLUS every scanEvidence.candidates entry folded
  // in via candidateAsRelevantConversation. A reply can be created from
  // either source, so filtering only relevantConversations silently missed
  // any conversation.id that only existed via that second, candidate-based
  // path -- exactly the gap that made this fix appear broken in practice.

  const disconnectReddit = async () => {
    if (!onDisconnectReddit || disconnectingReddit) return;
    setDisconnectingReddit(true);
    try {
      await onDisconnectReddit();
    } finally {
      setDisconnectingReddit(false);
    }
  };

  const createReply = async (conversation: RelevantConversation) => {
    if (!onCreateReply || creatingReplyId) return;
    setCreatingReplyId(conversation.id);
    try {
      const content = await onCreateReply(conversation.id, conversation.externalId);
      if (content) {
        setCreatedReplies((current) => ({ ...current, [conversation.id]: content }));
      }
    } finally {
      setCreatingReplyId((current) => (current === conversation.id ? null : current));
    }
  };

  const regenerateReply = async (opportunity: RedditOpportunity) => {
    const regenerated = await onRegenerateReply?.(opportunity.id);
    if (regenerated) {
      setDrafts((current) => ({ ...current, [opportunity.id]: regenerated }));
      return;
    }
    const choices = [opportunity.reply.draft, ...opportunity.reply.alternateDrafts];
    const nextIndex = ((regenerationIndex[opportunity.id] ?? 0) + 1) % choices.length;
    setDrafts((current) => ({ ...current, [opportunity.id]: choices[nextIndex] }));
    setRegenerationIndex((current) => ({
      ...current,
      [opportunity.id]: nextIndex,
    }));
  };

  const copyReply = async (opportunityId: string) => {
    const value =
      drafts[opportunityId] ??
      data.opportunities.find((opportunity) => opportunity.id === opportunityId)?.reply.draft ??
      "";
    try {
      if (!(await copyBrowserText(value))) throw new Error("Clipboard unavailable");
      setCopiedReplyId(opportunityId);
      window.setTimeout(() => setCopiedReplyId(null), 1800);
    } catch {
      setCopiedReplyId(null);
    }
  };

  const publishReply = async (opportunity: RedditOpportunity) => {
    if (publishedOpportunityIds.includes(opportunity.id)) return;
    const accepted = await onPublishOpportunity?.(
      opportunity.id,
      drafts[opportunity.id] ?? opportunity.reply.draft,
    );
    if (accepted === false) return;
    setPublishedIds((current) => [...current, opportunity.id]);
  };

  // One ranking axis across everything that passed filtering -- a lead and a
  // relevant-but-not-lead conversation are both "AI reliability checked,
  // source linked," so they browse as one swipeable carousel instead of a
  // carousel for leads plus a separate static list underneath it. Beyond
  // those two, every remaining candidate the lightweight AI shortlisted
  // (triage.worthEnriching) is folded in too, reshaped into the same card
  // via candidateAsRelevantConversation -- this is the dashboard's one and
  // only results view now; there is no separate technical scan-trace list.
  const carouselItems = useMemo<CarouselItem[]>(() => {
    const opportunityItems: CarouselItem[] = rankedOpportunities.map((opportunity) => ({
      kind: "opportunity",
      id: opportunity.id,
      reliability: opportunity.classification.relevanceScore,
      opportunity,
    }));
    const relevantItems: CarouselItem[] = relevantConversations.map((conversation) => ({
      kind: "relevant",
      id: conversation.id,
      reliability: conversation.reliabilityScore,
      conversation,
    }));
    // A candidate already represented as an opportunity or a relevant
    // conversation (same public Reddit URL) must not appear a second time
    // as a lighter, reply-less card.
    const representedPermalinks = new Set(
      [...rankedOpportunities, ...relevantConversations]
        .map((item) => item.permalink)
        .filter((permalink): permalink is string => Boolean(permalink)),
    );
    const candidateItems: CarouselItem[] = (data.scanEvidence?.candidates ?? [])
      .filter((candidate) => candidate.triage.worthEnriching)
      .filter((candidate) => !(candidate.permalink && representedPermalinks.has(candidate.permalink)))
      .map((candidate) => {
        const conversation = candidateAsRelevantConversation(candidate);
        const item: CarouselItem = {
          kind: "relevant",
          id: conversation.id,
          reliability: conversation.reliabilityScore,
          conversation,
        };
        return item;
      });
    return [...opportunityItems, ...relevantItems, ...candidateItems].sort(
      (a, b) => b.reliability - a.reliability,
    );
  }, [rankedOpportunities, relevantConversations, data.scanEvidence]);

  const hasAnyRelevantContent = carouselItems.length > 0;

  const isFree = accessLevel === "free";
  // "Results" only ever shows something real for a free-tier user who
  // hasn't upgraded yet -- additionalLockedCounts (its whole basis) is
  // hardcoded to all zeros for any fullAccess viewer (presenter.ts), so
  // for every paid/authenticated user this tab is structurally
  // guaranteed to always read "Nothing else is hidden," on every scan,
  // forever. Hidden here rather than deleted outright: Opportunities
  // and Replies locked-counts have no other home the way Insights'/
  // Competitors' own already do (their own screens already show "{N}
  // more ... stored" inline), so a free-tier viewer still needs this
  // tab to see those two specifically.
  // "Replies" is hidden unconditionally for everyone -- unlike Results
  // (still real for free-tier viewers), this one has no access-level
  // dependency: it's a duplicate, less useful presentation of the same
  // opportunities the Tinder-style carousel already covers one at a
  // time with the full generate/edit/publish flow.
  const navSections = (data.navigation ?? []).filter(
    (item) => (isFree || item.id !== "results") && item.id !== "replies",
  );
  const activeNavItem = navSections.find((item) => item.id === activeSection);
  const sectionSubtitles: Record<NavigationSectionId, string> = {
    dashboard: "The strongest market signals from this scan.",
    opportunities: "One at a time, strongest match first.",
    insights: "Patterns across everything we've read.",
    competitors: "Reddit mentions of you and the tools you compete with.",
    visibility: "Whether assistants name you, and what they read.",
    replies: "Drafts, posted replies and what they did.",
    results: "Anything stored beyond what's already shown elsewhere in this scan.",
    monitoring: "Daily Reddit monitoring, watch terms and your Reddit connection.",
    analytics: "See where useful demand is coming from.",
    settings: "Your business profile, competitors and Reddit connection.",
    billing: "Your plan and how to change it.",
  };
  const goToSection = (id: NavigationSectionId) => () => setActiveSection(id);

  const topCarouselItems = carouselItems.slice(0, 3);
  // Lead with the value the scan actually produced. "Qualified opportunity"
  // is a deliberately strict subset, so making a zero in that subset the
  // overview headline hid the useful conversations, replies, and market
  // evidence already present in the same report. Positive-only cards keep
  // the overview truthful without advertising an internal funnel rejection.
  const overviewMetrics = [
    {
      label: "Promising conversations",
      value: carouselItems.length,
      note: "Relevant matches, ranked by AI",
    },
    {
      label: "High-intent matches",
      value: data.metrics.highIntentOpportunities,
      note: "Worth replying to first",
    },
    {
      label: "Replies ready",
      value: data.metrics.readyReplies,
      note: `Ready to review${data.metrics.publishedReplies > 0 ? `, ${data.metrics.publishedReplies} posted` : " and use"}`,
    },
    {
      label: "Market insights",
      value: data.insights.length + data.conversationThemes.length,
      note: "Demand patterns uncovered",
    },
    {
      label: "Competitor signals",
      value: data.metrics.competitorSignals,
      note: "Mentioned in relevant results",
    },
    {
      label: "Reddit posts reviewed",
      value: data.scanEvidence?.diagnostics.normalized ?? 0,
      note: "Checked for relevance and intent",
    },
    {
      label: "Search phrases tested",
      value: data.scanEvidence?.searchPlan.length ?? 0,
      note: "Using your approved wording",
    },
    {
      label: "Website pages analyzed",
      value: data.business.analyzedPageCount,
      note: "Used to understand product fit",
    },
  ].filter((metric) => metric.value > 0).slice(0, 4);

  if (activeSection === "billing") {
    const planIdForAccessLevel: Record<AccessLevel, PricingPlan["id"]> = {
      free: "market-scan",
      pass: "full-access-pass",
      core: "core",
    };
    const currentPlan =
      data.pricing.find((plan) => plan.id === planIdForAccessLevel[accessLevel]) ??
      data.pricing[0];
    const formatPrice = (plan: PricingPlan) =>
      plan.priceInCents === 0 ? "$0" : `$${(plan.priceInCents / 100).toFixed(0)}`;
    const upgradePlans = isFree ? data.pricing.filter((plan) => plan.id !== "market-scan") : [];

    return (
      <>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Instrument+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
        <div className={styles.billingStandalone}>
          <header className={styles.billingHeader}>
            <button type="button" className={styles.billingHeaderLogo} onClick={goToSection("dashboard")}>
              <Icon name="logo" size={26} />
              Scooptr
            </button>
            <button type="button" className={styles.billingBackLink} onClick={goToSection("dashboard")}>
              &larr; Back to dashboard
            </button>
            <span className={styles.billingHeaderSpacer} />
            <span className={styles.billingUserChip}>{data.business.hostname}</span>
          </header>

          <div className={styles.billingContent}>
            <div>
              <h1>Billing</h1>
              <p className={styles.appHeaderSub}>Your plan and how to change it.</p>
            </div>

            <div className={styles.lightSection}>
              <div className={styles.simpleCard}>
                <span className={styles.simpleCardEyebrow}>current plan</span>
                <span className={styles.simpleCardTitle}>{currentPlan.name}</span>
                <p className={styles.simpleCardBody}>{currentPlan.description}</p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {currentPlan.features.map((feature) => (
                    <span
                      key={feature}
                      className={styles.todayTag}
                      style={{ background: "var(--green-soft)", color: "var(--green-dark)" }}
                    >
                      {feature}
                    </span>
                  ))}
                </div>
                <span className={styles.simpleCardMeta}>{currentPlan.checkoutNote}</span>
              </div>

              {upgradePlans.map((plan) => (
                <div key={plan.id} className={styles.simpleCard}>
                  <span className={styles.simpleCardEyebrow}>
                    {formatPrice(plan)}
                    {plan.cadence === "monthly" ? "/month" : plan.cadence === "one-time" ? ` one-time \u00b7 ${plan.durationDays ?? 7} days` : ""}
                  </span>
                  <span className={styles.simpleCardTitle}>{plan.name}</span>
                  <p className={styles.simpleCardBody}>{plan.description}</p>
                  {onCheckout && (plan.id === "full-access-pass" || plan.id === "core") && (
                    <button
                      type="button"
                      className={styles.blueCta}
                      style={{ alignSelf: "flex-start" }}
                      onClick={() => onCheckout(plan.id as CheckoutPlanId)}
                    >
                      Choose {plan.name}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {/* Design handoff (design_handoff_scooptr) specifies Instrument Sans
       * and IBM Plex Mono; loaded here (rather than globally) so the rest
       * of the product experience keeps its existing fonts -- same
       * per-surface scoping used on the landing page. */}
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link
        href="https://fonts.googleapis.com/css2?family=Instrument+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
        rel="stylesheet"
      />
      {activeSection === "dashboard" && isFree && onCheckout && !valuePropDismissed && (
        <div className={styles.valuePropOverlay}>
          <div className={styles.valuePropModal}>
            <button
              type="button"
              className={styles.valuePropClose}
              onClick={() => setValuePropDismissed(true)}
              aria-label="Dismiss"
            >
              &times;
            </button>
            <span className={styles.valuePropEyebrow}>{data.business.hostname}</span>
            <h2>Monitoring isn&apos;t running on {data.business.hostname} yet</h2>
            <p>
              What you&apos;re looking at is a one-time snapshot from your free scan. New
              conversations show up on Reddit every day, and none of them get read until a plan
              is active.
            </p>
            <div className={styles.valuePropCards}>
              <div className={styles.valuePropCard}>
                <strong>Be first in the thread</strong>
                <p>
                  People post exactly this problem on Reddit every day. Whoever replies first
                  with something useful usually gets named.
                </p>
              </div>
              <div className={styles.valuePropCard}>
                <strong>Replies keep working after you write them</strong>
                <p>
                  Reddit threads rank in Google search results for years. One good reply keeps
                  sending people your way long after you post it.
                </p>
              </div>
              <div className={styles.valuePropCard}>
                <strong>Show up when people ask AI instead</strong>
                <p>
                  ChatGPT and Perplexity often quote Reddit threads when someone asks what tool
                  to use for something.
                </p>
              </div>
            </div>
            <button type="button" className={styles.blueCta} onClick={goToSection("billing")}>
              Start finding customers &rarr;
            </button>
          </div>
        </div>
      )}

      <div className={styles.appShell}>
      <aside className={styles.scSidebar}>
        <div className={styles.scSidebarLogo}>
          <span className={styles.scSidebarLogoMark}>
            <Icon name="logo" size={28} />
          </span>
          <span className={styles.scSidebarLogoText}>Scooptr</span>
        </div>

        <div className={styles.scSidebarBusiness}>
          <span className={styles.scSidebarBusinessAvatar}>
            {data.business.hostname.slice(0, 2).toUpperCase()}
          </span>
          <span className={styles.scSidebarBusinessLabel}>{data.business.hostname}</span>
        </div>

        <nav className={styles.scSidebarNav}>
          {(() => {
            const inboxIds: NavigationSectionId[] = ["opportunities", "competitors"];
            const inboxItems = navSections.filter((item) => inboxIds.includes(item.id));
            const inboxBadgeTotal = inboxItems.reduce((sum, item) => sum + (item.badge ?? 0), 0);
            const inboxActive = inboxIds.includes(activeSection);
            const navItemButton = (item: NavigationSection, indented?: boolean) => (
              <button
                key={item.id}
                type="button"
                onClick={goToSection(item.id)}
                className={`${styles.scSidebarNavItem} ${indented ? styles.scSidebarNavItemIndented : ""} ${
                  item.id === activeSection ? styles.scSidebarNavItemActive : ""
                }`}
              >
                <span>{item.label}</span>
                {item.badge ? <span className={styles.scSidebarNavBadge}>{item.badge}</span> : null}
              </button>
            );
            return navSections.map((item) => {
              if (inboxIds.includes(item.id)) {
                if (item.id !== "opportunities") return null;
                return (
                  <div className={styles.scSidebarInboxGroup} key="inbox-group">
                    <button
                      type="button"
                      className={`${styles.scSidebarNavItem} ${styles.scSidebarInboxHeader} ${
                        inboxActive ? styles.scSidebarNavItemActive : ""
                      }`}
                      onClick={() => setInboxOpen((open) => !open)}
                    >
                      <span>Inbox</span>
                      {inboxBadgeTotal > 0 && <span className={styles.scSidebarNavBadge}>{inboxBadgeTotal}</span>}
                      <span className={styles.scSidebarInboxChevron} aria-hidden="true">
                        {inboxOpen ? "⌄" : "⌃"}
                      </span>
                    </button>
                    {inboxOpen && (
                      <div className={styles.scSidebarInboxChildren}>
                        {inboxItems.map((child) => navItemButton(child, true))}
                      </div>
                    )}
                  </div>
                );
              }
              return navItemButton(item);
            });
          })()}
        </nav>

        {isFree && onCheckout && (
          <div className={styles.scSidebarSpacer}>
            <div className={styles.sideCard}>
              <strong>Monitoring is off</strong>
              <p className={styles.simpleCardBody} style={{ margin: 0 }}>
                Your scan was a snapshot. New conversations appear every day &mdash; you&apos;re
                not seeing them yet.
              </p>
              <button
                type="button"
                className={styles.blueCta}
                onClick={() => onCheckout("core")}
              >
                Upgrade access
              </button>
            </div>
          </div>
        )}
      </aside>

      <div className={styles.appMain}>
        <header className={styles.appHeader}>
          <div className={styles.appHeaderTitleGroup}>
            <h1 className={styles.appHeaderTitle}>{activeNavItem?.label ?? "Overview"}</h1>
            <p className={styles.appHeaderSub}>{sectionSubtitles[activeSection]}</p>
          </div>
          <div className={styles.appHeaderActions}>
            {isFree && <span className={styles.planPill}>free scan</span>}
            {onNewScan && (
              <button className={styles.textButton} type="button" onClick={onNewScan}>
                New scan
              </button>
            )}
            {isFree && onCheckout && (
              <button type="button" className={styles.darkCta} onClick={() => onCheckout("core")}>
                Upgrade
              </button>
            )}
          </div>
        </header>

        <div className={styles.appContent}>
          {(usesMockProvider || isFixtureFallbackForSubmittedDomain) && (
            <MockProviderNotice
              label={
                usesMockProvider
                  ? "Some results use labeled demo/mock data"
                  : "Fallback demo fixture shown"
              }
              disclosure={fixtureDisclosure}
            />
          )}

          {activeSection === "dashboard" && (
            <div className={styles.overviewGrid}>
              <div className={styles.metricsRow}>
                {overviewMetrics.map((metric) => (
                  <div className={styles.scMetricCard} key={metric.label}>
                    <span className={styles.scMetricLabel}>{metric.label}</span>
                    <span className={styles.scMetricValue}>{metric.value}</span>
                    <span className={styles.scMetricNote}>{metric.note}</span>
                  </div>
                ))}
              </div>

              <div className={styles.overviewMain}>
                <div className={styles.todayCard}>
                  <div className={styles.todayCardHead}>
                    <div className={styles.todayCardHeadText}>
                      <strong>Worth your time today</strong>
                      <span>Ordered by AI reliability, highest first</span>
                    </div>
                    <button
                      type="button"
                      className={styles.ghostButton}
                      onClick={goToSection("opportunities")}
                    >
                      See all
                    </button>
                    </div>
                    {topCarouselItems.length === 0 ? (
                      <p className={styles.todayEmpty}>
                        Nothing cleared qualification this run.
                      </p>
                    ) : (
                      topCarouselItems.map((item) => {
                        const title = item.kind === "opportunity" ? item.opportunity.title : item.conversation.title;
                        const subreddit = item.kind === "opportunity" ? item.opportunity.subreddit : item.conversation.subreddit;
                        const why =
                          item.kind === "opportunity"
                            ? item.opportunity.classification.customerProblem
                            : item.conversation.summary;
                        return (
                          <div key={item.id} className={styles.todayItem}>
                            <div className={styles.todayItemBody}>
                              <div className={styles.todayItemMeta}>
                                <span>{subreddit}</span>
                                <span
                                  className={styles.todayTag}
                                  style={{ background: "var(--amber-soft)", color: "var(--amber)" }}
                                >
                                  {item.kind === "opportunity" ? "opportunity" : "relevant"}
                                </span>
                              </div>
                              <span className={styles.todayTitle}>{title}</span>
                              <span className={styles.todayWhy}>{why}</span>
                            </div>
                            <button
                              type="button"
                              className={styles.ghostButton}
                              onClick={goToSection("opportunities")}
                            >
                              Review
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
          )}

          {activeSection === "opportunities" && (
            <div className={styles.opportunitiesScreen}>
              <section className={styles.dashboardSection} style={{ margin: 0 }}>
                {!hasAnyRelevantContent ? (
                  <section className={`${styles.card} ${styles.emptyResults}`}>
                    <h2>No relevant Reddit posts or comments were found in this scan.</h2>
                    <p>Nothing cleared qualification this run; nothing was substituted to fill the space.</p>
                  </section>
                ) : (
                  carouselItems.length > 0 && (
                    <TrackedSection event="opportunity_preview_viewed" onView={onFunnelEvent}>
                      <div className={styles.sectionHeadingRow}>
                        <div>
                          <h2>Reddit posts found:</h2>
                        </div>
                      </div>
                      <OpportunityCarousel
                        items={carouselItems}
                        drafts={drafts}
                        editingReplyId={editingReplyId}
                        copiedReplyId={copiedReplyId}
                        publishedOpportunityIds={publishedOpportunityIds}
                        onDraftChange={(opportunityId, value) =>
                          setDrafts((current) => ({ ...current, [opportunityId]: value }))
                        }
                        onToggleEdit={(opportunityId) =>
                          setEditingReplyId((current) => (current === opportunityId ? null : opportunityId))
                        }
                        onRegenerate={(opportunity) => regenerateReply(opportunity)}
                        onCopy={(opportunityId) => void copyReply(opportunityId)}
                        onPublish={(opportunity) => void publishReply(opportunity)}
                        redditConnection={redditConnection}
                        onFunnelEvent={onFunnelEvent}
                        createdReplies={createdReplies}
                        creatingReplyId={creatingReplyId}
                        onCreateReply={(conversation) => void createReply(conversation)}
                        reviewMarks={reviewMarks}
                        onSetReviewMark={(itemId, status) => void setReviewMark(itemId, status)}
                      />
                    </TrackedSection>
                  )
                )}
              </section>
            </div>
          )}

          {activeSection === "insights" && (
            <div className={styles.lightSection}>
              <InsightsFilterTabs
                filter={insightsFilter}
                onFilterChange={setInsightsFilter}
                counts={{
                  all:
                    data.conversationThemes.filter((theme) => theme.kind === "struggle").length +
                    data.conversationThemes.filter((theme) => theme.kind === "request").length +
                    data.insights.length,
                  pains: data.conversationThemes.filter((theme) => theme.kind === "struggle").length,
                  requests: data.conversationThemes.filter((theme) => theme.kind === "request").length,
                  patterns: data.insights.length,
                }}
              />
              {(insightsFilter === "all" || insightsFilter === "pains") && (
                <ThemeSection
                  kind="struggle"
                  eyebrow="Recurring pain"
                  heading="What customers are struggling with"
                  themes={data.conversationThemes}
                />
              )}
              {(insightsFilter === "all" || insightsFilter === "requests") && (
                <ThemeSection
                  kind="request"
                  eyebrow="Recurring requests"
                  heading="What they are asking for"
                  themes={data.conversationThemes}
                />
              )}
              {(insightsFilter === "all" || insightsFilter === "patterns") && data.insights.length > 0 && (
                <section className={styles.dashboardSection}>
                  <div className={styles.sectionHeadingRow}>
                    <div>
                      <span className={styles.eyebrow}>Demand patterns</span>
                      <h2>Patterns that should influence positioning</h2>
                    </div>
                  </div>
                  <div className={styles.insightColumn}>
                    {/* Stronger patterns (more supporting conversations) lead --
                        sourceCount already exists on every insight (from-scan.ts
                        guarantees it via a sourceIds-based fallback), so this
                        reorders existing data rather than inventing a new score. */}
                    {[...data.insights]
                      .sort((a, b) => (b.sourceCount ?? 0) - (a.sourceCount ?? 0))
                      .map((insight) => (
                        <DemandPatternCard key={insight.id} insight={insight} />
                      ))}
                  </div>
                </section>
              )}
              {isFree && onCheckout && data.lockedCounts.insights > 0 && (
                <div className={styles.simpleEmpty}>
                  <div className={styles.emptyIcon} />
                  <strong>
                    {data.lockedCounts.insights} more insight{data.lockedCounts.insights === 1 ? "" : "s"} stored
                  </strong>
                  <p>
                    Patterns need volume. After daily monitoring runs for a while, this is where the
                    recurring problems and requests show up &mdash; with the conversations that prove them.
                  </p>
                  <button type="button" className={styles.blueCta} onClick={() => onCheckout("core")}>
                    Turn on monitoring
                  </button>
                  <span className={styles.emptyFoot}>needs about a week of data</span>
                </div>
              )}
            </div>
          )}

          {activeSection === "visibility" && (
            <div className={styles.lightSection}>
              <AiVisibilityPanel
                key={aiVisibility ? `${aiVisibility.enabled}:${aiVisibility.nextRunAt}` : "ai-visibility-unavailable"}
                status={aiVisibility}
                onUpdate={onUpdateAiVisibility}
                scans={visibilityScans}
              />
            </div>
          )}

          {activeSection === "competitors" && (
            <div className={styles.lightSection}>
              {data.competitorWeaknesses.length === 0 ? (
                <div className={styles.simpleEmpty}>
                  <div className={styles.emptyIcon} />
                  <strong>No competitor signals yet</strong>
                  <p>
                    We didn&apos;t find any complaints about named competitors in this scan. Once
                    monitoring is on, we&apos;ll surface it the moment someone asks for an alternative.
                  </p>
                </div>
              ) : (
                data.competitorWeaknesses.map((weakness) => (
                  <div key={weakness.id} className={styles.simpleCard}>
                    <span className={styles.simpleCardEyebrow}>
                      {weakness.competitorName ?? "Unnamed competitor"}
                    </span>
                    <span className={styles.simpleCardTitle}>{weakness.headline}</span>
                    <p className={styles.simpleCardBody}>{weakness.summary}</p>
                    <span className={styles.simpleCardMeta}>{weakness.recommendedAction}</span>
                  </div>
                ))
              )}
              {isFree && onCheckout && data.lockedCounts.competitorSignals > 0 && (
                <div className={styles.simpleEmpty}>
                  <div className={styles.emptyIcon} />
                  <strong>
                    {data.lockedCounts.competitorSignals} more competitor signal
                    {data.lockedCounts.competitorSignals === 1 ? "" : "s"} stored
                  </strong>
                  <p>
                    Found and stored from this scan. Turn on monitoring to keep watching for new ones
                    every day instead of just this one snapshot.
                  </p>
                  <button type="button" className={styles.blueCta} onClick={() => onCheckout("core")}>
                    Turn on monitoring
                  </button>
                  <span className={styles.emptyFoot}>from this scan</span>
                </div>
              )}
            </div>
          )}

          {activeSection === "results" && isFree && (
            <div className={styles.lightSection}>
              {data.lockedCounts ? (() => {
                // These are counts of ADDITIONAL, currently-hidden findings
                // beyond what's already shown elsewhere in the dashboard --
                // not a total of everything the scan found. When nothing is
                // held back (e.g. full access, or a small scan with nothing
                // left over), every field here is legitimately zero. The old
                // headline claimed this was the scan's full total, so a
                // zero read as "the scan found nothing at all." Label what's
                // actually being measured, and give the zero case its own
                // honest copy instead of a misleading all-zero total.
                const totalLocked =
                  data.lockedCounts.opportunities +
                  data.lockedCounts.insights +
                  data.lockedCounts.competitorSignals +
                  data.lockedCounts.visibilityOpportunities +
                  data.lockedCounts.readyReplies;
                if (totalLocked === 0) {
                  return (
                    <div className={styles.simpleCard}>
                      <span className={styles.simpleCardTitle}>Nothing else is hidden</span>
                      <p className={styles.simpleCardBody}>
                        Everything this scan found is already visible in Opportunities,
                        Insights, Competitors, and Replies.
                      </p>
                    </div>
                  );
                }
                return (
                  <div className={styles.simpleCard}>
                    <span className={styles.simpleCardTitle}>More is stored than shown here</span>
                    <p className={styles.simpleCardBody}>
                      {data.lockedCounts.opportunities} opportunities &middot;{" "}
                      {data.lockedCounts.insights} insights &middot;{" "}
                      {data.lockedCounts.competitorSignals} competitor signals &middot;{" "}
                      {data.lockedCounts.visibilityOpportunities} visibility opportunities &middot;{" "}
                      {data.lockedCounts.readyReplies} ready replies
                    </p>
                    {isFree && (
                      <span className={styles.simpleCardMeta}>
                        Some of this is stored but not shown on the free scan.
                      </span>
                    )}
                  </div>
                );
              })() : (
                <div className={styles.simpleEmpty}>
                  <strong>Nothing stored yet</strong>
                  <p>Results from this scan will appear here once they&apos;re available.</p>
                </div>
              )}
            </div>
          )}

          {activeSection === "monitoring" && (
            <div className={styles.lightSection}>
              <BusinessSummaryEditor
                summary={data.business.oneLineSummary}
                onUpdate={onUpdateBusinessSummary}
              />

              <RedditMonitoringPanel
                key={monitoring
                  ? `config:${monitoring.enabled}:${monitoring.watchTerms.map((term) => `${term.kind}:${term.active}:${term.value}`).join("|")}`
                  : "monitoring-config-unavailable"}
                monitoring={monitoring}
                onUpdate={onUpdateMonitoring}
                runs={monitorRuns}
                onViewRun={onViewMonitorRun}
                recommendedSubredditNames={recommendedSubreddits}
              />

              <div className={styles.simpleCard}>
                {redditConnection.connected && (
                  <p className={styles.simpleCardBody} style={{ margin: 0 }}>
                    {`Connected as u/${redditConnection.username}. Replies can be posted straight from Opportunities.`}
                  </p>
                )}
                {redditConnection.connected ? (
                  <button
                    type="button"
                    className={styles.ghostButton}
                    style={{ alignSelf: "flex-start" }}
                    onClick={() => void disconnectReddit()}
                    disabled={disconnectingReddit}
                  >
                    {disconnectingReddit ? "Disconnecting\u2026" : "Disconnect Reddit"}
                  </button>
                ) : redditConnection.canConnect ? (
                  <button
                    type="button"
                    className={styles.darkCta}
                    style={{ alignSelf: "flex-start" }}
                    onClick={onConnectReddit}
                  >
                    Connect Reddit
                  </button>
                ) : redditConnection.requiresPaidAccess ? (
                  <span className={styles.simpleCardMeta}>Posting to Reddit requires a paid plan.</span>
                ) : null}
              </div>
            </div>
          )}

          {activeSection === "analytics" && (
            <div className={styles.lightSection}>
              <AnalyticsKpiRow data={subredditPerformance} />
              <div className={styles.analyticsChartsRow}>
                <SubredditActivityChart data={subredditPerformance} />
                <DemandMixDonut data={subredditPerformance} />
              </div>
              <div className={styles.analyticsInsightsRow}>
                <BestOpportunitySourceCard data={subredditPerformance} />
                <AiCitedCommunitiesCard data={subredditPerformance} />
              </div>
              <SubredditPerformanceTable data={subredditPerformance} />
            </div>
          )}

          {activeSection === "settings" && (
            <div className={styles.lightSection}>
              <BusinessProfilePanel profile={data.business} />

              <div className={styles.simpleCard}>
                {redditConnection.connected && (
                  <p className={styles.simpleCardBody} style={{ margin: 0 }}>
                    {`Connected as u/${redditConnection.username}. Replies can be posted straight from Opportunities.`}
                  </p>
                )}
                {redditConnection.connected ? (
                  <button
                    type="button"
                    className={styles.ghostButton}
                    style={{ alignSelf: "flex-start" }}
                    onClick={() => void disconnectReddit()}
                    disabled={disconnectingReddit}
                  >
                    {disconnectingReddit ? "Disconnecting\u2026" : "Disconnect Reddit"}
                  </button>
                ) : redditConnection.canConnect ? (
                  <button
                    type="button"
                    className={styles.darkCta}
                    style={{ alignSelf: "flex-start" }}
                    onClick={onConnectReddit}
                  >
                    Connect Reddit
                  </button>
                ) : redditConnection.requiresPaidAccess ? (
                  <span className={styles.simpleCardMeta}>Posting to Reddit requires a paid plan.</span>
                ) : null}
              </div>

              {data.business.competitors.length > 0 && (
                <div className={styles.simpleCard}>
                  <span className={styles.simpleCardTitle}>Competitors identified</span>
                  <p className={styles.simpleCardBody} style={{ margin: 0 }}>
                    Tools we watch for alongside your own keywords, found from your website.
                  </p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                    {data.business.competitors.map((competitor) => (
                      <span key={competitor} className={styles.todayTag} style={{ background: "#f4f4f5", color: "#3f3f46" }}>
                        {competitor}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

        </div>
      </div>
      </div>
    </>
  );
}
