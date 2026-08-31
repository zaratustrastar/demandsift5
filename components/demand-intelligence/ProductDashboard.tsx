"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { REDDIT_MONITOR_LIMITS } from "@/lib/intelligence/reddit-monitor-limits";

import { redditDemandDemoData } from "./demo-data";
import type {
  BusinessProfile,
  ConversationTheme,
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

export type RedditMonitoringStatus = {
  enabled: boolean;
  watchTerms: Array<{
    value: string;
    kind: "brand" | "competitor" | "keyword";
    active: boolean;
  }>;
  lastSuccessfulMonitorAt: string | null;
  nextRunAt: string;
};

export type AiVisibilityStatus = {
  enabled: boolean;
  lastSuccessfulScanAt: string | null;
  nextRunAt: string;
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
  /** Recent daily monitoring runs, most recent first -- the "where will I see results" answer for Reddit monitoring. */
  monitorRuns?: RedditMonitorRunSummary[] | null;
  /** Loads a completed monitoring run's own scan into view, in place, without leaving the dashboard. */
  onViewMonitorRun?: (scanId: string) => Promise<void> | void;
  aiVisibility?: AiVisibilityStatus | null;
  onUpdateAiVisibility?: (enabled: boolean) => Promise<boolean>;
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

function RedditMonitoringPanel({
  monitoring,
  onUpdate,
  runs,
  onViewRun,
}: {
  monitoring: RedditMonitoringStatus | null;
  onUpdate?: ProductDashboardProps["onUpdateMonitoring"];
  runs?: RedditMonitorRunSummary[] | null;
  onViewRun?: ProductDashboardProps["onViewMonitorRun"];
}) {
  const [terms, setTerms] = useState(() =>
    monitoring?.watchTerms
      .filter((term) => term.active)
      .slice(0, REDDIT_MONITOR_LIMITS.maxWatchTerms)
      .map((term) => term.value)
      .join("\n") ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [viewingRunId, setViewingRunId] = useState<string | null>(null);
  if (!monitoring) return null;

  const parsedTerms = (): RedditMonitoringStatus["watchTerms"] => [...new Set(
    terms.split(/\r?\n|,/u).map((value) => value.replace(/\s+/gu, " ").trim()).filter(Boolean),
  )].slice(0, REDDIT_MONITOR_LIMITS.maxWatchTerms).map((value) => {
    const existing = monitoring.watchTerms.find(
      (term) => term.value.toLocaleLowerCase("en-US") === value.toLocaleLowerCase("en-US"),
    );
    return { value, kind: existing?.kind ?? "keyword", active: true };
  });

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
      <label className={styles.monitoringTerms}>
        <span>Brand, competitor and keyword watch terms</span>
        <small>
          Up to {REDDIT_MONITOR_LIMITS.maxWatchTerms} terms and {REDDIT_MONITOR_LIMITS.maxResultsPerRun} raw results per daily run.
        </small>
        <textarea
          value={terms}
          rows={Math.min(8, Math.max(4, terms.split("\n").length))}
          disabled={saving}
          onChange={(event) => setTerms(event.currentTarget.value)}
        />
      </label>
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

  const latest = scans?.[0] ?? null;
  const providerErrors = latest
    ? (Object.entries(latest.providerErrors) as Array<[AiVisibilityProvider, string | null]>).filter(
        ([, message]) => Boolean(message),
      )
    : [];

  return (
    <section className={`${styles.card} ${styles.monitoringCard}`}>
      <div>
        <span className={styles.eyebrow}>AI visibility tracking</span>
        <h2>See how ChatGPT, Gemini and Perplexity answer about you</h2>
        <p>
          Once a week, the same questions are put to ChatGPT, Gemini and Perplexity to check whether
          your business is mentioned or recommended, and which sources they cite.
        </p>
      </div>
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
            {latest.metrics && (
              <p className={styles.resultsMeta}>
                Mentioned in {latest.metrics.totalMentions} of {latest.metrics.totalAnswers} answers (
                {Math.round(latest.metrics.mentionRate * 100)}%) · Recommended {latest.metrics.totalRecommendations} time
                {latest.metrics.totalRecommendations === 1 ? "" : "s"}
              </p>
            )}
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
            {latest.answers.length > 0 && (
              <ul className={styles.resultsList}>
                {latest.answers.map((answer, index) => (
                  <li key={`${answer.provider}-${index}`} className={styles.resultsRow}>
                    <div className={styles.resultsRowHead}>
                      <span className={styles.resultsProvider}>{aiVisibilityProviderLabel(answer.provider)}</span>
                      {answer.brandMentioned && (
                        <span className={`${styles.resultsStatus} ${styles.resultsStatusOk}`}>
                          {answer.brandRecommended ? "Recommended" : "Mentioned"}
                        </span>
                      )}
                    </div>
                    <p className={styles.resultsMeta}>{answer.question}</p>
                    {answer.answerText ? (
                      <details className={styles.resultsAnswer}>
                        <summary>View answer{answer.citations.length > 0 ? ` (${answer.citations.length} source${answer.citations.length === 1 ? "" : "s"})` : ""}</summary>
                        <FormattedAnswerText text={answer.answerText} />
                        {answer.citations.length > 0 && (
                          <ul className={styles.resultsCitations}>
                            {answer.citations.map((citation) => (
                              <li key={citation.url}>
                                <a href={citation.url} target="_blank" rel="noreferrer noopener">
                                  {citation.title || citation.domain}
                                </a>
                              </li>
                            ))}
                          </ul>
                        )}
                      </details>
                    ) : (
                      <p className={styles.resultsEmpty}>No answer was returned for this question.</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  );
}

type IconName =
  | "arrow"
  | "arrowLeft"
  | "check"
  | "copy"
  | "edit"
  | "external"
  | "logo"
  | "refresh"
  | "star";

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const glyphs: Record<IconName, string> = {
    arrow: "\u2192",
    arrowLeft: "\u2190",
    check: "\u2713",
    copy: "\u29c9",
    edit: "\u270e",
    external: "\u2197",
    logo: "\u2713",
    refresh: "\u21bb",
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
        </div>
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
 * The single card shown by OpportunityCarousel. Same underlying fields as
 * OpportunityCard (relevanceScore, matchReasons, permalink, reply) -- this
 * is a presentation variant for the single-card carousel, not a new data
 * shape.
 */
function CarouselOpportunityCard({
  opportunity,
  isRevealed,
  onToggleReply,
}: {
  opportunity: RedditOpportunity;
  isRevealed: boolean;
  onToggleReply: () => void;
}) {
  const tags = reliabilitySignalTags(opportunity);
  const whyItMatters = opportunity.matchReasons[0] ?? opportunity.classification.customerProblem;

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
      </div>

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
        <button className={styles.primaryButton} type="button" onClick={onToggleReply}>
          <Icon name="refresh" size={14} />
          {isRevealed ? "Hide reply" : "Generate reply"}
        </button>
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
}: {
  items: CarouselItem[];
  drafts: Record<string, string>;
  editingReplyId: string | null;
  copiedReplyId: string | null;
  publishedOpportunityIds: string[];
  onDraftChange: (opportunityId: string, value: string) => void;
  onToggleEdit: (opportunityId: string) => void;
  onRegenerate: (opportunity: RedditOpportunity) => void;
  onCopy: (opportunityId: string) => void;
  onPublish: (opportunity: RedditOpportunity) => void;
  redditConnection: RedditConnectionStatus;
  onFunnelEvent?: (name: FunnelEventName) => Promise<void> | void;
  createdReplies: Record<string, string>;
  creatingReplyId: string | null;
  onCreateReply: (conversation: RelevantConversation) => void;
}) {
  const [index, setIndex] = useState(0);
  const [revealedReplyIds, setRevealedReplyIds] = useState<Set<string>>(new Set());
  const total = items.length;

  // Derived rather than stored: if the underlying list ever changes size
  // (e.g. a fresh scan result swaps in a shorter list) the position clamps
  // back into range on the next render without a setState-in-effect, and
  // without touching the list or its order.
  const safeIndex = total === 0 ? 0 : Math.min(index, total - 1);
  const item = items[safeIndex];
  if (!item) return null;

  const goTo = (nextIndex: number) => setIndex(((nextIndex % total) + total) % total);
  const toggleReply = (itemId: string) => {
    setRevealedReplyIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };
  const isRevealed = revealedReplyIds.has(item.id);

  return (
    <div
      className={styles.carousel}
      role="group"
      aria-roledescription="carousel"
      aria-label="Reddit posts found, ordered by AI reliability, highest first"
    >
      {item.kind === "opportunity" ? (
        <CarouselOpportunityCard
          opportunity={item.opportunity}
          isRevealed={isRevealed}
          onToggleReply={() => toggleReply(item.id)}
        />
      ) : (
        <CarouselRelevantCard
          conversation={item.conversation}
          isRevealed={isRevealed}
          onToggleReply={() => toggleReply(item.id)}
          createdDraft={createdReplies[item.conversation.id]}
          isCreatingReply={creatingReplyId === item.conversation.id}
          onCreateReply={() => onCreateReply(item.conversation)}
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

      <p className={styles.carouselCaption}>
        Ordered by AI reliability, highest first. Later conversations may be less reliable.
      </p>
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
  monitorRuns = null,
  onViewMonitorRun,
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
  // Opportunities and Competitors are the two screens that fill in on their
  // own as monitoring runs -- grouped under one collapsible "Inbox" header,
  // open by default. AI Citations/Live feed from the original design don't
  // exist yet (no pipeline behind them), so this stays a two-item group
  // rather than the full four-item one until those are real.
  const [inboxOpen, setInboxOpen] = useState(true);
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

  const navSections = data.navigation ?? [];
  const activeNavItem = navSections.find((item) => item.id === activeSection);
  const sectionSubtitles: Record<NavigationSectionId, string> = {
    dashboard: "What changed since you were last here.",
    opportunities: "One at a time, strongest match first.",
    insights: "Patterns across everything we've read.",
    competitors: "Reddit mentions of you and the tools you compete with.",
    visibility: "Whether assistants name you, and what they read.",
    replies: "Drafts, posted replies and what they did.",
    results: "Everything this scan found, including what's stored but not shown.",
    settings: "Your business profile, competitors and Reddit connection.",
    billing: "Your plan and how to change it.",
  };
  const goToSection = (id: NavigationSectionId) => () => setActiveSection(id);
  const isFree = accessLevel === "free";

  const topCarouselItems = carouselItems.slice(0, 3);

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
              <Icon name="logo" size={14} />
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
      <div className={styles.appShell}>
      <aside className={styles.scSidebar}>
        <div className={styles.scSidebarLogo}>
          <span className={styles.scSidebarLogoMark}>
            <Icon name="logo" size={14} />
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
                <div className={styles.scMetricCard}>
                  <span className={styles.scMetricLabel}>Opportunities found</span>
                  <span className={styles.scMetricValue}>{data.metrics.qualifiedOpportunities}</span>
                  <span className={styles.scMetricNote}>Qualified this scan</span>
                </div>
                <div className={styles.scMetricCard}>
                  <span className={styles.scMetricLabel}>High intent</span>
                  <span className={styles.scMetricValue}>{data.metrics.highIntentOpportunities}</span>
                  <span className={styles.scMetricNote}>Worth replying to first</span>
                </div>
                <div className={styles.scMetricCard}>
                  <span className={styles.scMetricLabel}>Replies ready</span>
                  <span className={styles.scMetricValue}>{data.metrics.readyReplies}</span>
                  <span className={styles.scMetricNote}>Drafted, {data.metrics.publishedReplies} posted</span>
                </div>
                <div className={styles.scMetricCard}>
                  <span className={styles.scMetricLabel}>Competitor signals</span>
                  <span className={styles.scMetricValue}>{data.metrics.competitorSignals}</span>
                  <span className={styles.scMetricNote}>Mentioned in your results</span>
                </div>
              </div>

              <div className={styles.overviewColumns}>
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

                <div className={styles.overviewSide}>
                  <RedditMonitoringPanel
                    key={monitoring
                      ? `${monitoring.enabled}:${monitoring.watchTerms.map((term) => `${term.kind}:${term.active}:${term.value}`).join("|")}`
                      : "monitoring-unavailable"}
                    monitoring={monitoring}
                    onUpdate={onUpdateMonitoring}
                    runs={monitorRuns}
                    onViewRun={onViewMonitorRun}
                  />
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
                        <span className={styles.qualityNote}>AI relevance checked &middot; Source linked</span>
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
                        onRegenerate={(opportunity) => void regenerateReply(opportunity)}
                        onCopy={(opportunityId) => void copyReply(opportunityId)}
                        onPublish={(opportunity) => void publishReply(opportunity)}
                        redditConnection={redditConnection}
                        onFunnelEvent={onFunnelEvent}
                        createdReplies={createdReplies}
                        creatingReplyId={creatingReplyId}
                        onCreateReply={(conversation) => void createReply(conversation)}
                      />
                    </TrackedSection>
                  )
                )}
              </section>
            </div>
          )}

          {activeSection === "insights" && (
            <div className={styles.lightSection}>
              <ThemeSection
                kind="struggle"
                eyebrow="Recurring pain"
                heading="What customers are struggling with"
                themes={data.conversationThemes}
              />
              <ThemeSection
                kind="request"
                eyebrow="Recurring requests"
                heading="What they are asking for"
                themes={data.conversationThemes}
              />
              {data.insights.length > 0 &&
                data.insights.map((insight) => (
                  <div key={insight.id} className={styles.simpleCard}>
                    <span className={styles.simpleCardEyebrow}>{insight.eyebrow}</span>
                    <span className={styles.simpleCardTitle}>{insight.title}</span>
                    <p className={styles.simpleCardBody}>{insight.summary}</p>
                    <span className={styles.simpleCardMeta}>{insight.recommendedAction}</span>
                  </div>
                ))}
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

          {activeSection === "replies" && (
            <div className={styles.lightSection}>
              <div className={styles.simpleCard}>
                <span className={styles.simpleCardTitle}>
                  {publishedOpportunityIds.length} posted &middot; {rankedOpportunities.length} drafted
                </span>
                <p className={styles.simpleCardBody} style={{ margin: 0 }}>
                  Nothing is ever posted without you reading it first.
                </p>
              </div>
              {rankedOpportunities.map((opportunity) => {
                const isPublished = publishedOpportunityIds.includes(opportunity.id);
                return (
                  <div key={opportunity.id} className={styles.simpleCard}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                      <span className={styles.simpleCardEyebrow}>{opportunity.subreddit}</span>
                      <span
                        className={styles.todayTag}
                        style={
                          isPublished
                            ? { background: "var(--green-soft)", color: "var(--green-dark)" }
                            : { background: "#f4f4f5", color: "#52525b" }
                        }
                      >
                        {isPublished ? "posted" : "draft"}
                      </span>
                    </div>
                    <span className={styles.simpleCardTitle}>{opportunity.title}</span>
                    <p className={styles.simpleCardBody}>
                      {drafts[opportunity.id] ?? opportunity.reply.draft}
                    </p>
                    <button
                      type="button"
                      className={styles.ghostButton}
                      onClick={goToSection("opportunities")}
                      style={{ alignSelf: "flex-start" }}
                    >
                      Open in Opportunities
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {activeSection === "results" && (
            <div className={styles.lightSection}>
              {data.lockedCounts ? (
                <div className={styles.simpleCard}>
                  <span className={styles.simpleCardTitle}>Everything this scan found</span>
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
              ) : (
                <div className={styles.simpleEmpty}>
                  <strong>Nothing stored yet</strong>
                  <p>Results from this scan will appear here once they&apos;re available.</p>
                </div>
              )}
            </div>
          )}

          {activeSection === "settings" && (
            <div className={styles.lightSection}>
              <BusinessProfilePanel profile={data.business} />

              <div className={styles.simpleCard}>
                <span className={styles.simpleCardTitle}>Reddit account</span>
                <p className={styles.simpleCardBody} style={{ margin: 0 }}>
                  {redditConnection.connected
                    ? `Connected as u/${redditConnection.username}. Replies can be posted straight from Opportunities.`
                    : "Connect it to post replies from here. Without it you copy and paste \u2014 the drafts work either way."}
                </p>
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
