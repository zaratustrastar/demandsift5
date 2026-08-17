"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { redditDemandDemoData } from "./demo-data";
import type {
  BusinessProfile,
  CompetitorWeakness,
  DemandInsight,
  InsightEvidence,
  LockedResultCounts,
  LockedStoredResult,
  ConversationTheme,
  NavigationSectionId,
  PricingPlan,
  RedditDemandDemoData,
  RedditOpportunity,
  RelevantConversation,
  ScanEvidence,
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
  onFunnelEvent?: (name: FunnelEventName) => Promise<void> | void;
}

type IconName =
  | NavigationSectionId
  | "arrow"
  | "check"
  | "copy"
  | "edit"
  | "external"
  | "lock"
  | "logo"
  | "refresh"
  | "sparkles";

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const glyphs: Record<IconName, string> = {
    dashboard: "▦",
    opportunities: "◈",
    insights: "↗",
    competitors: "△",
    visibility: "◎",
    replies: "◌",
    results: "⌁",
    billing: "▭",
    settings: "⚙",
    arrow: "→",
    check: "✓",
    copy: "⧉",
    edit: "✎",
    external: "↗",
    lock: "▣",
    logo: "✓",
    refresh: "↻",
    sparkles: "✦",
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

function formatPrice(plan: PricingPlan) {
  if (plan.priceInCents === 0) return "Free";
  return `$${plan.priceInCents / 100}`;
}

function intentLabel(intent: RedditOpportunity["classification"]["buyerIntent"]) {
  return intent === "high" ? "High buyer intent" : `${intent[0].toUpperCase()}${intent.slice(1)} intent`;
}

function potentialIntentLabel(intent: RedditOpportunity["potentialCustomerIntent"]) {
  if (intent === "high_intent") return "Actively looking";
  if (intent === "competitor_switching") return "Frustrated with an alternative";
  if (intent === "problem_aware") return "Problem aware";
  return "Relevant demand signal";
}

function EvidenceSourceLink({ evidence }: { evidence: InsightEvidence }) {
  if (!evidence.sourceUrl) return <cite>{evidence.sourceLabel}</cite>;
  return (
    <cite>
      <a
        href={evidence.sourceUrl}
        target="_blank"
        rel="noreferrer noopener"
        aria-label={"View source: " + evidence.sourceLabel}
      >
        View public source <Icon name="external" size={12} />
      </a>
    </cite>
  );
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

function accessLabel(accessLevel: AccessLevel) {
  if (accessLevel === "core") return "Core plan";
  if (accessLevel === "pass") return "7-day pass";
  return "Free scan";
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

function MetricCard({
  label,
  value,
  note,
  tone = "neutral",
}: {
  label: string;
  value: number | string;
  note: string;
  tone?: "neutral" | "mint" | "violet" | "amber";
}) {
  return (
    <article className={`${styles.metricCard} ${styles[`metric_${tone}`]}`}>
      <span className={styles.metricLabel}>{label}</span>
      <strong>{value}</strong>
      <span className={styles.metricNote}>{note}</span>
    </article>
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


export function ScanEvidencePanel({ evidence }: { evidence: ScanEvidence }) {
  const rejected = [
    ...Object.entries(evidence.diagnostics.providerRejectedByReason ?? {}),
    ...Object.entries(evidence.diagnostics.deterministicRejectedByReason ?? {}),
  ].filter(([, count]) => count > 0);

  return (
    <details className={styles.dashboardSection}>
      <summary className={styles.sectionHeadingRow} style={{ cursor: "pointer", listStyle: "none" }}>
        <div>
          <span className={styles.eyebrow}>Technical detail</span>
          <h2>Show full scan trace</h2>
        </div>
        <span className={styles.qualityNote}>{evidence.candidates.length} candidates reviewed</span>
      </summary>

      <section className={`${styles.card} ${styles.profileCard}`}>
        <div className={styles.opportunityMeta}>
          <span><b>{evidence.diagnostics.retrieved}</b> provider records found</span>
          <span><b>{evidence.diagnostics.deterministicSurvivors}</b> credible candidates analyzed</span>
          <span><b>{evidence.diagnostics.worthEnriching}</b> selected by lightweight AI</span>
          <span><b>{evidence.diagnostics.enrichedSuccessfully}</b> full threads verified</span>
          <span><b>{evidence.diagnostics.deepQualificationsReturned}</b> deep AI decisions</span>
        </div>
        {evidence.diagnostics.coverageLimited && (
          <p className={styles.provenanceFootnote}>
            Full-context coverage was limited: {evidence.diagnostics.enrichedSuccessfully} verified versus a target of {evidence.diagnostics.requiredFullContextReviews ?? 0}. This report therefore does not treat zero potential customers as definitive.
          </p>
        )}
        <details>
          <summary><strong>Search plan ({evidence.searchPlan.length} queries)</strong></summary>
          <ul className={styles.cleanList}>
            {evidence.searchPlan.map((entry, index) => (
              <li key={`${entry.lane}-${entry.query}-${index}`}>
                <span className={styles.listDot} />
                <span><b>{intelligenceLabel(entry.lane)}</b>: {entry.query}</span>
              </li>
            ))}
          </ul>
        </details>
        {rejected.length > 0 && (
          <details>
            <summary><strong>Rejected before AI ({rejected.reduce((sum, [, count]) => sum + count, 0)})</strong></summary>
            <div className={styles.opportunityMeta}>
              {rejected.map(([reason, count]) => (
                <span key={reason}><b>{count}</b> {intelligenceLabel(reason)}</span>
              ))}
            </div>
          </details>
        )}
      </section>

      <div className={styles.opportunityStack}>
        {evidence.candidates.map((candidate, index) => {
          const deep = candidate.deepQualification;
          const status = deep
            ? deep.leadStatus === "potential_customer" && !candidate.fullContextVerified
              ? "Provisional customer signal — context not verified"
              : intelligenceLabel(deep.leadStatus)
            : candidate.triage.worthEnriching
              ? "Selected for full-context review"
              : candidate.triage.relevant
                ? "Relevant at lightweight triage"
                : "Not selected by lightweight triage";
          return (
            <details className={styles.opportunityCard} key={candidate.externalId}>
              <summary>
                <strong>{index + 1}. {candidate.title || "Reddit comment"}</strong>
                <span> · r/{candidate.subreddit} · {status}</span>
              </summary>
              <div className={styles.mockExcerpt}>
                <span>Public message excerpt</span>
                <p>“{candidate.excerpt}”</p>
              </div>
              <div className={styles.opportunityMeta}>
                <span><b>{candidate.fullContextVerified ? "Yes" : "No"}</b> full thread context</span>
                <span><b>{intelligenceLabel(candidate.triage.intent)}</b> triage intent</span>
                <span><b>{intelligenceLabel(candidate.triage.productFit)}</b> triage fit</span>
                {deep && <span><b>{intelligenceLabel(deep.leadStatus)}</b> deep result</span>}
              </div>
              <div className={styles.fitReasonGrid}>
                <div>
                  <span className={styles.fieldLabel}>Why lightweight AI made this decision</span>
                  <p>{candidate.triage.reason}</p>
                </div>
                <div>
                  <span className={styles.fieldLabel}>Deep review</span>
                  <p>{deep?.whyItMatters ?? "Not sent to deep qualification."}</p>
                </div>
              </div>
              {candidate.matchedQueries.length > 0 && (
                <div>
                  <span className={styles.fieldLabel}>Matched search attribution</span>
                  <p>{candidate.matchedQueries.join(" · ")}</p>
                </div>
              )}
              {candidate.permalink && (
                <div className={styles.opportunityAction}>
                  <span>Exact discovery message retained from the provider.</span>
                  <a
                    className={styles.secondaryButton}
                    href={candidate.permalink}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Open exact Reddit message <Icon name="external" size={14} />
                  </a>
                </div>
              )}
            </details>
          );
        })}
      </div>
    </details>
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

export function DemandInsightCard({ insight }: { insight: DemandInsight }) {
  return (
    <article className={styles.insightCard}>
      <div className={styles.insightIcon}>
        <Icon name="insights" size={19} />
      </div>
      <div className={styles.insightBody}>
        <div className={styles.sectionHeadingRow}>
          <div>
            <span className={styles.eyebrow}>{insight.eyebrow}</span>
            <h3>{insight.title}</h3>
          </div>
          <span className={styles.confidencePill}>
            {insight.signalStrength} signal
          </span>
        </div>
        <p className={styles.cardSummary}>{insight.summary}</p>
        <div className={styles.evidenceGrid}>
          {insight.evidence.map((evidence) => (
            <blockquote key={evidence.provenanceId}>
              <span>{evidence.sourceLabel}</span>
              <p>{evidence.quote}</p>
              <EvidenceSourceLink evidence={evidence} />
            </blockquote>
          ))}
        </div>
        <div className={styles.actionStrip}>
          <Icon name="arrow" size={15} />
          <p>
            <strong>What to do:</strong> {insight.recommendedAction}
          </p>
        </div>
      </div>
    </article>
  );
}

export function CompetitorWeaknessCard({
  weakness,
}: {
  weakness: CompetitorWeakness;
}) {
  const evidence = weakness.evidence[0];
  if (!weakness.verified || !weakness.competitorName || !evidence) {
    return (
      <article className={`${styles.card} ${styles.competitorCard}`}>
        <div className={styles.competitorBadge}>
          <Icon name="competitors" size={18} />
          No verified competitor signal
        </div>
        <h3>No verified competitor weakness in this scan</h3>
        <p>
          No qualified conversation contained a source-backed competitor complaint
          or comparison, so Threadline has not inferred one.
        </p>
        <div className={styles.actionStrip}>
          <Icon name="check" size={15} />
          <p>Keep monitoring for an explicit comparison or complaint.</p>
        </div>
        <p className={styles.provenanceFootnote}>
          No competitor identity, weakness, count or evidence is shown without a
          qualified source.
        </p>
      </article>
    );
  }

  return (
    <article className={`${styles.card} ${styles.competitorCard}`}>
      <div className={styles.competitorBadge}>
        <Icon name="competitors" size={18} />
        Competitor opening
      </div>
      <h3>{weakness.headline}</h3>
      <p>{weakness.summary}</p>
      <blockquote className={styles.competitorQuote}>
        <span>
          {weakness.competitorIsFictionalDemo
            ? "Mock conversation signal"
            : "Public conversation signal"}
        </span>
        {evidence.quote}
        <EvidenceSourceLink evidence={evidence} />
      </blockquote>
      <div className={styles.actionStrip}>
        <Icon name="arrow" size={15} />
        <p>
          <strong>Opportunity:</strong> {weakness.recommendedAction}
        </p>
      </div>
      <p className={styles.provenanceFootnote}>
        {weakness.competitorIsFictionalDemo
          ? `${weakness.competitorName} appears only in labeled mock-provider evidence. This is one directional signal, not a broad market claim.`
          : "This is one source-backed directional signal, not a claim about broad market sentiment."}
      </p>
    </article>
  );
}

export function LockedResultsPanel({
  counts,
  onUnlock,
  context = "scan",
}: {
  counts: LockedResultCounts;
  onUnlock?: () => void;
  context?: "scan" | "section";
}) {
  const leadResult = counts.opportunities
    ? { count: counts.opportunities, label: "provider opportunities" }
    : (counts.relevantConversations ?? 0)
      ? { count: counts.relevantConversations ?? 0, label: "relevant conversations" }
      : counts.insights
      ? { count: counts.insights, label: "demand insights" }
      : counts.competitorSignals
        ? { count: counts.competitorSignals, label: "competitor signals" }
        : {
            count: counts.visibilityOpportunities,
            label: "visibility opportunities",
          };
  const rows = [
    {
      label: "Qualified opportunities",
      count: counts.opportunities,
      width: "84%",
    },
    {
      label: "Relevant conversations",
      count: counts.relevantConversations ?? 0,
      width: "74%",
    },
    { label: "Demand insights", count: counts.insights, width: "68%" },
    {
      label: "Competitor signals",
      count: counts.competitorSignals,
      width: "76%",
    },
    {
      label: "Search & AI Visibility Opportunities",
      count: counts.visibilityOpportunities,
      width: "61%",
    },
  ].filter((row) => row.count > 0);

  return (
    <section className={styles.lockedPanel}>
      <div className={styles.lockedGlow} />
      <div className={styles.lockedHeader}>
        <span className={styles.lockIcon}>
          <Icon name="lock" size={17} />
        </span>
        <div>
          <span className={styles.eyebrow}>
            {context === "scan" ? "Your scan found more" : "More stored findings"}
          </span>
          <h3>
            {leadResult.count} additional {leadResult.label} are already stored
          </h3>
        </div>
      </div>
      <p className={styles.lockedIntro}>
        These counts come directly from stored provider records. Details stay
        blurred in the free scan; mock-provider records remain clearly labeled
        and do not represent live Reddit data.
      </p>
      <div className={styles.blurredList}>
        {rows.map((row) => (
          <div key={row.label} className={styles.blurredRow}>
            <span className={styles.blurredIcon} />
            <div>
              <span style={{ width: row.width }} />
              <small>{row.label}</small>
            </div>
            <strong>+{row.count}</strong>
          </div>
        ))}
      </div>
      <div className={styles.lockedFooter}>
        <p>
          Plus <strong>{counts.readyReplies} additional ready replies</strong> and
          seven days of monitoring with the Full Access Pass.
        </p>
        {onUnlock && (
          <button className={styles.primaryButton} type="button" onClick={onUnlock}>
            Unlock for $12 <Icon name="arrow" size={15} />
          </button>
        )}
      </div>
    </section>
  );
}

function MarketScanLockedPanel({
  total,
  visible,
  records,
  counts,
  onUnlock,
}: {
  total: number;
  visible: number;
  records: LockedStoredResult[];
  counts: LockedResultCounts;
  onUnlock?: () => void;
}) {
  const additional = Math.max(0, total - visible);
  const proofRows = [
    additional > 0 ? `+${additional} potential customer opportunities` : "",
    counts.readyReplies > 0 ? `+${counts.readyReplies} suggested replies` : "",
    (counts.relevantConversations ?? 0) > 0
      ? `+${counts.relevantConversations} relevant conversations`
      : "",
    counts.competitorSignals > 0 ? `+${counts.competitorSignals} competitor weaknesses` : "",
    counts.insights > 0 ? `+${counts.insights} recurring customer problems` : "",
  ].filter(Boolean);

  return (
    <section className={`${styles.lockedPanel} ${styles.marketLockedPanel}`}>
      <div className={styles.lockedGlow} />
      <div className={styles.marketLockedHeader}>
        <div>
          <span className={styles.eyebrow}>The rest of your scan is ready</span>
          <h3>
            {total > 0
              ? <>You&apos;ve seen {visible} of {total} potential customer opportunities.</>
              : "More source-backed Market Scan findings are ready."}
          </h3>
          <p>These previews correspond to real stored records; their identifying details remain locked.</p>
        </div>
        <span className={styles.lockIcon}><Icon name="lock" size={17} /></span>
      </div>
      {records.length > 0 && (
        <div className={styles.lockedOpportunityGrid} aria-label="Locked stored opportunity previews">
          {records.slice(0, 3).map((record) => (
            <article className={styles.lockedOpportunityCard} key={record.id}>
              <div>
                <span>{potentialIntentLabel(record.potentialCustomerIntent)}</span>
                <small>{relativeTime(record.capturedAt)} · {record.subreddit} · {record.conversationType}</small>
              </div>
              <i /><i /><i />
              <footer>
                <span>{record.supportingSignalCount ?? 1} source-backed signal{(record.supportingSignalCount ?? 1) === 1 ? "" : "s"}</span>
                <b>Reply ready</b>
              </footer>
            </article>
          ))}
        </div>
      )}
      {proofRows.length > 0 && (
        <div className={styles.lockedProofRow}>
          {proofRows.map((row) => <span key={row}>{row}</span>)}
        </div>
      )}
      <div className={styles.marketLockedCta}>
        <div>
          <strong>Full access for 7 days</strong>
          <span>One-time payment · No automatic renewal · Tax calculated at checkout</span>
        </div>
        {onUnlock && (
          <button className={styles.primaryButton} type="button" onClick={onUnlock}>
            {total > 0 ? `See all ${total} opportunities — $12` : "Unlock full report — $12"} <Icon name="arrow" size={15} />
          </button>
        )}
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

function SectionIntro({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <header className={styles.pageIntro}>
      <div>
        <span className={styles.eyebrow}>{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </header>
  );
}

function PricingCard({
  plan,
  featured,
  onCheckout,
}: {
  plan: PricingPlan;
  featured?: boolean;
  onCheckout?: (planId: CheckoutPlanId) => void;
}) {
  const isPaid = plan.id !== "market-scan";
  const checkoutId = plan.id === "core" ? "core" : "full-access-pass";

  return (
    <article
      className={`${styles.pricingCard} ${featured ? styles.pricingFeatured : ""}`}
    >
      {featured && <span className={styles.featuredLabel}>Launch offer</span>}
      <span className={styles.eyebrow}>{plan.cadence}</span>
      <h3>{plan.name}</h3>
      <div className={styles.priceLine}>
        <strong>{formatPrice(plan)}</strong>
        {plan.cadence === "monthly" && <span>/ month</span>}
        {plan.durationDays && <span>for {plan.durationDays} days</span>}
      </div>
      <p>{plan.description}</p>
      <ul className={styles.planFeatures}>
        {plan.features.map((feature) => (
          <li key={feature}>
            <Icon name="check" size={14} /> {feature}
          </li>
        ))}
      </ul>
      <button
        className={featured ? styles.primaryButton : styles.secondaryButtonWide}
        type="button"
        disabled={!isPaid}
        onClick={() => isPaid && onCheckout?.(checkoutId)}
      >
        {plan.id === "market-scan" ? "Current access" : `Choose ${plan.name}`}
        {isPaid && <Icon name="arrow" size={15} />}
      </button>
      <small>{plan.checkoutNote}</small>
      {plan.requiresVerifiedWebhook && (
        <span className={styles.webhookNote}>
          <Icon name="lock" size={12} /> Access begins only after a verified Stripe
          webhook.
        </span>
      )}
    </article>
  );
}

export function ProductDashboard({
  data: fixtureData = redditDemandDemoData,
  scanResult,
  analyzedDomain,
  initialSection = "dashboard",
  accessLevel = "free",
  onNewScan,
  onCheckout,
  onRegenerateReply,
  onPublishOpportunity,
  onRecordClick,
  onRecordConversion,
  redditConnection = {
    configured: false,
    connected: false,
    username: null,
    canConnect: false,
    requiresPaidAccess: true,
  },
  onConnectReddit,
  onDisconnectReddit,
  onFunnelEvent,
}: ProductDashboardProps) {
  const data = scanResult ?? fixtureData;
  const relevantConversations = data.relevantConversations ?? [];
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
    ? `${data.fixtureDisclosure} The facts below were not produced from ${analyzedDomain}; Relaywise is a clearly separated fallback fixture while the real scan result is unavailable.`
    : data.fixtureDisclosure;
  const usesFictionalBusiness = data.business.isFictionalDemoBusiness;
  const usesMockProvider =
    data.opportunities.some((opportunity) => opportunity.isMock) ||
    relevantConversations.some((conversation) => conversation.isMock);
  const usesApifyTestProvider =
    data.opportunities.some((opportunity) => opportunity.provider === "apify-reddit-test") ||
    relevantConversations.some((conversation) => conversation.provider === "apify-reddit-test");
  const [activeSection, setActiveSection] =
    useState<NavigationSectionId>(initialSection);
  const [selectedOpportunityId, setSelectedOpportunityId] = useState(
    data.opportunities[0]?.id ?? "",
  );
  const [editingReplyId, setEditingReplyId] = useState<string | null>(null);
  const [copiedReplyId, setCopiedReplyId] = useState<string | null>(null);
  const [publishedIds, setPublishedIds] = useState<string[]>([]);
  const [recordedClicks, setRecordedClicks] = useState(0);
  const [recordedConversions, setRecordedConversions] = useState(0);
  const [regenerationIndex, setRegenerationIndex] = useState<
    Record<string, number>
  >({});
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      data.opportunities.map((opportunity) => [
        opportunity.id,
        opportunity.reply.draft,
      ]),
    ),
  );

  const hasFullAccess = accessLevel !== "free";
  const availableReplyOpportunities = hasFullAccess
    ? data.opportunities
    : data.opportunities.slice(0, 1);
  const selectedOpportunity =
    availableReplyOpportunities.find(
      (opportunity) => opportunity.id === selectedOpportunityId,
    ) ?? availableReplyOpportunities[0];
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

  const metrics = useMemo(
    () => ({
      ...data.metrics,
      publishedReplies: Math.max(
        data.metrics.publishedReplies,
        publishedOpportunityIds.length,
      ),
      trackedClicks: data.metrics.trackedClicks + recordedClicks,
      trackedConversions: data.metrics.trackedConversions + recordedConversions,
    }),
    [data.metrics, publishedOpportunityIds.length, recordedClicks, recordedConversions],
  );
  const potentialCustomers = data.potentialCustomers ?? {
    total: usesMockProvider ? 0 : data.metrics.qualifiedOpportunities,
    conversationCount: usesMockProvider ? 0 : data.metrics.qualifiedOpportunities,
    windowDays: 7,
    windowStartedAt: data.generatedAt,
    windowEndedAt: data.generatedAt,
    breakdown: {
      highIntent: usesMockProvider ? 0 : data.metrics.highIntentOpportunities,
      competitorSwitching: 0,
      problemAware: usesMockProvider
        ? 0
        : Math.max(0, data.metrics.qualifiedOpportunities - data.metrics.highIntentOpportunities),
    },
    newSincePreviousDemandDrop: usesMockProvider ? 0 : data.metrics.qualifiedOpportunities,
  };

  const openReply = (opportunityId: string) => {
    const isAvailable = availableReplyOpportunities.some(
      (opportunity) => opportunity.id === opportunityId,
    );
    if (!isAvailable) {
      setActiveSection("billing");
      return;
    }
    setSelectedOpportunityId(opportunityId);
    setActiveSection("replies");
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

  const unlock = () => {
    void onFunnelEvent?.("unlock_cta_clicked");
    onCheckout?.("full-access-pass");
    setActiveSection("billing");
  };

  const recordConversion = async () => {
    const opportunityId = publishedOpportunityIds[0];
    if (!opportunityId) return;
    const accepted = await onRecordConversion?.(opportunityId);
    if (accepted !== false) setRecordedConversions((current) => current + 1);
  };

  const recordClick = async () => {
    const opportunityId = publishedOpportunityIds[0];
    if (!opportunityId) return;
    const accepted = await onRecordClick?.(opportunityId);
    if (accepted !== false) setRecordedClicks((current) => current + 1);
  };

  const renderMarketScan = () => {
    const visibleOpportunities = potentialCustomers.total > 0
      ? data.opportunities.slice(0, 3)
      : [];
    const previewReply = potentialCustomers.total > 0
      ? availableReplyOpportunities[0]
      : undefined;
    const hasOtherUsefulContent =
      relevantConversations.length > 0 ||
      data.competitorWeaknesses.some((item) => item.verified) ||
      data.insights.length > 0 ||
      data.visibilityOpportunities.length > 0;
    const strongestFallback = relevantConversations.length > 0
      ? `${relevantConversations.length} source-backed relevant conversation${relevantConversations.length === 1 ? " is" : "s are"} available below.`
      : data.competitorWeaknesses.some((item) => item.verified)
        ? "A source-backed competitor mention is available below."
        : data.insights.length > 0
        ? `${data.insights.length} source-backed demand signal${data.insights.length === 1 ? " is" : "s are"} available below.`
        : data.visibilityOpportunities.length > 0
          ? `${data.visibilityOpportunities.length} Search & AI Visibility Opportunit${data.visibilityOpportunities.length === 1 ? "y is" : "ies are"} available below.`
          : "No weaker mention was promoted into a potential-customer claim.";
    const hasLockedValue = !usesMockProvider && (
      data.lockedCounts.opportunities > 0 ||
      data.lockedCounts.readyReplies > 0 ||
      (data.lockedCounts.relevantConversations ?? 0) > 0 ||
      data.lockedCounts.competitorSignals > 0 ||
      data.lockedCounts.insights > 0
    );

    return (
      <div className={styles.marketScanReport}>
        <TrackedSection event="potential_customer_count_revealed" onView={onFunnelEvent}>
          <section className={`${styles.card} ${styles.customerHero}`}>
            <span className={styles.eyebrow}>Your personalized Market Scan</span>
            {potentialCustomers.total > 0 ? (
              <>
                <h1><strong>{potentialCustomers.total}</strong> {potentialCustomers.total === 1 ? "person" : "people"} may need what you&apos;re building.</h1>
                <p>
                  Found across <b>{potentialCustomers.conversationCount}</b> source-backed Reddit conversation{potentialCustomers.conversationCount === 1 ? "" : "s"} in the last {potentialCustomers.windowDays} days.
                </p>
              </>
            ) : (
              <>
                <h1>
                  {hasOtherUsefulContent
                    ? "Market Scan complete."
                    : data.qualificationCoverage?.limited
                      ? "No verified potential customers yet."
                      : "No candidates passed qualification in this scan."}
                </h1>
                <p>
                  {strongestFallback} Reviewed {data.qualificationCoverage?.fullContextReviewed ?? 0} of {data.qualificationCoverage?.credibleCandidates ?? 0} credible recent candidates with additional Reddit thread context.
                  {data.qualificationCoverage?.limited
                    ? ` The full-context confidence target was ${data.qualificationCoverage.requiredFullContextReviews ?? 0}, so this is not a definitive zero.`
                    : ""}
                </p>
              </>
            )}
            <div className={styles.customerHeroFoot}>
              <span><Icon name="check" size={13} /> Unique Reddit authors only</span>
              <span><Icon name="check" size={13} /> Recent public sources</span>
              <span><Icon name="check" size={13} /> Low-confidence matches excluded</span>
            </div>
          </section>
        </TrackedSection>

        {potentialCustomers.total > 0 && (
          <section className={styles.intentBreakdown} aria-label="Potential customer intent breakdown">
            <article>
              <strong>{potentialCustomers.breakdown.highIntent}</strong>
              <span>Actively looking for or comparing a solution</span>
            </article>
            <article>
              <strong>{potentialCustomers.breakdown.competitorSwitching}</strong>
              <span>Frustrated with or switching from alternatives</span>
            </article>
            <article>
              <strong>{potentialCustomers.breakdown.problemAware}</strong>
              <span>Experiencing problems {data.business.name} solves</span>
            </article>
          </section>
        )}

        {(visibleOpportunities.length > 0 || !hasOtherUsefulContent) && (
          <TrackedSection event="opportunity_preview_viewed" onView={onFunnelEvent}>
            <section className={styles.dashboardSection}>
              <div className={styles.sectionHeadingRow}>
                <div>
                  <span className={styles.eyebrow}>People and intent</span>
                  <h2>{visibleOpportunities.length > 0 ? "The strongest potential-customer opportunities" : "No qualified people to preview"}</h2>
                </div>
                <span className={styles.qualityNote}>One opportunity per unique author</span>
              </div>
              <div className={styles.opportunityStack}>
                {visibleOpportunities.map((opportunity) => (
                  <OpportunityCard key={opportunity.id} opportunity={opportunity} onOpenReply={openReply} />
                ))}
                {visibleOpportunities.length === 0 && (
                  <section className={`${styles.card} ${styles.emptyResults}`}>
                    <span className={styles.emptyResultsIcon}><Icon name="opportunities" size={23} /></span>
                    <h2>No weak matches were substituted</h2>
                    <p>The scan found no recent, source-backed author with enough problem, recommendation, comparison or competitor-switching evidence to qualify.</p>
                  </section>
                )}
              </div>
            </section>
          </TrackedSection>
        )}

        {relevantConversations.length > 0 && (
          <section className={styles.dashboardSection}>
            <div className={styles.sectionHeadingRow}>
              <div>
                <span className={styles.eyebrow}>Relevant conversations</span>
                <h2>Useful market evidence that is not a potential lead</h2>
              </div>
              <span className={styles.qualityNote}>Thread-context reviewed · Source linked</span>
            </div>
            <div className={styles.opportunityStack}>
              {relevantConversations.slice(0, 3).map((conversation) => (
                <RelevantConversationCard key={conversation.id} conversation={conversation} />
              ))}
            </div>
          </section>
        )}

        {previewReply && (
          <TrackedSection event="suggested_reply_viewed" onView={onFunnelEvent}>
            <section className={styles.dashboardSection}>
              <div className={styles.sectionHeadingRow}>
                <div>
                  <span className={styles.eyebrow}>One complete suggested reply</span>
                  <h2>Answer the person first, then add useful context</h2>
                </div>
                <span className={styles.qualityNote}>Grounded in verified website facts</span>
              </div>
              <ReplyComposer
                opportunity={previewReply}
                value={drafts[previewReply.id] ?? previewReply.reply.draft}
                isEditing={editingReplyId === previewReply.id}
                isCopied={copiedReplyId === previewReply.id}
                isPublished={publishedOpportunityIds.includes(previewReply.id)}
                onChange={(value) => setDrafts((current) => ({ ...current, [previewReply.id]: value }))}
                onEdit={() => setEditingReplyId((current) => current === previewReply.id ? null : previewReply.id)}
                onRegenerate={() => void regenerateReply(previewReply)}
                onCopy={() => void copyReply(previewReply.id)}
                onPublish={() => void publishReply(previewReply)}
                redditConnection={redditConnection}
              />
            </section>
          </TrackedSection>
        )}

        <section className={styles.dashboardSection}>
          <div className={styles.sectionHeadingRow}>
            <div>
              <span className={styles.eyebrow}>Why these people were matched</span>
              <h2>Business understanding</h2>
            </div>
          </div>
          <BusinessProfilePanel profile={data.business} />
        </section>

        {data.scanEvidence && <ScanEvidencePanel evidence={data.scanEvidence} />}

        <section className={styles.dashboardSection}>
          <div className={styles.sectionHeadingRow}>
            <div>
              <span className={styles.eyebrow}>Where alternatives leave room</span>
              <h2>Competitor weaknesses</h2>
            </div>
          </div>
          {data.competitorWeaknesses.map((weakness) => (
            <CompetitorWeaknessCard key={weakness.id} weakness={weakness} />
          ))}
        </section>

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

        {data.insights.length > 0 && (
          <section className={styles.dashboardSection}>
            <div className={styles.sectionHeadingRow}>
              <div>
                <span className={styles.eyebrow}>Recurring customer demand</span>
                <h2>What people repeatedly need help with</h2>
              </div>
            </div>
            <div className={styles.insightColumn}>
              {data.insights.map((insight) => <DemandInsightCard key={insight.id} insight={insight} />)}
            </div>
          </section>
        )}

        {data.visibilityOpportunities.length > 0 && (
          <section className={styles.dashboardSection}>
            <div className={styles.sectionHeadingRow}>
              <div>
                <span className={styles.eyebrow}>Questions worth answering clearly</span>
                <h2>Search & AI Visibility Opportunities</h2>
              </div>
            </div>
            <div className={styles.visibilityGrid}>
              {data.visibilityOpportunities.map((item, index) => (
                <article key={item.id} className={`${styles.card} ${styles.visibilityCard}`}>
                  <span className={styles.visibilityNumber}>0{index + 1}</span>
                  <h3>{item.title}</h3>
                  <p>{item.summary}</p>
                  <div className={styles.actionStrip}><Icon name="arrow" size={15} /><p>{item.recommendedAction}</p></div>
                  <small>{item.verificationNote}</small>
                </article>
              ))}
            </div>
          </section>
        )}

        {hasLockedValue && (
          <TrackedSection event="locked_results_viewed" onView={onFunnelEvent}>
            <MarketScanLockedPanel
              total={potentialCustomers.total}
              visible={visibleOpportunities.length}
              records={data.lockedResults}
              counts={data.lockedCounts}
              onUnlock={unlock}
            />
          </TrackedSection>
        )}
      </div>
    );
  };

  const renderDashboard = () => (
    <>
      <SectionIntro
        eyebrow="Today’s demand brief"
        title="The conversations worth joining—without the noise."
        description={
          usesFictionalBusiness
            ? "This labeled sample shows how the strongest demand signals would be prioritized for a business."
            : usesMockProvider
              ? "Mock-provider conversations are ranked against problems verified on the submitted website, ready to be replaced by approved live Reddit data."
              : usesApifyTestProvider
                ? "Real public Reddit records from the Apify test source were qualified against the submitted website. This is MVP test data, not an approved production Reddit API integration."
                : "Potential customers are already describing relevant problems. Here are the strongest source-backed places the business can help."
        }
        action={
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={() => setActiveSection("opportunities")}
          >
            View all opportunities <Icon name="arrow" size={15} />
          </button>
        }
      />

      <div className={styles.metricsGrid}>
        <MetricCard
          label="Qualified opportunities"
          value={metrics.qualifiedOpportunities}
          note={`${metrics.highIntentOpportunities} show high buyer intent`}
          tone="mint"
        />
        <MetricCard
          label="Replies ready"
          value={metrics.readyReplies}
          note={
            usesFictionalBusiness
              ? "Grounded in labeled demo-site facts"
              : "Grounded in submitted website facts"
          }
          tone="violet"
        />
        <MetricCard
          label="Competitor signals"
          value={metrics.competitorSignals}
          note={
            usesMockProvider
              ? "Directional mock-provider evidence"
              : usesApifyTestProvider
                ? "Directional Apify test evidence"
                : "Directional approved-provider evidence"
          }
          tone="amber"
        />
        <MetricCard
          label="Published replies"
          value={metrics.publishedReplies}
          note={metrics.publishedReplies ? "Recorded for this workspace" : "No activity recorded yet"}
        />
      </div>

      <BusinessProfilePanel profile={data.business} />

      {data.scanEvidence && <ScanEvidencePanel evidence={data.scanEvidence} />}

      {(data.opportunities.length > 0 ||
        (relevantConversations.length === 0 &&
          !data.competitorWeaknesses.some((item) => item.verified) &&
          data.insights.length === 0)) && (
        <section className={styles.dashboardSection}>
          <div className={styles.sectionHeadingRow}>
            <div>
              <span className={styles.eyebrow}>Best current opportunities</span>
              <h2>
                {data.opportunities.length > 0
                  ? "Useful conversations to prioritize"
                  : "No conversation passed the qualification threshold"}
              </h2>
            </div>
            <span className={styles.qualityNote}>Noise and duplicates removed</span>
          </div>
          <div className={styles.opportunityStack}>
            {data.opportunities.slice(0, 3).map((opportunity) => (
              <OpportunityCard
                key={opportunity.id}
                opportunity={opportunity}
                onOpenReply={openReply}
              />
            ))}
            {data.opportunities.length === 0 && (
              <section className={`${styles.card} ${styles.emptyResults}`}>
                <span className={styles.emptyResultsIcon}>
                  <Icon name="opportunities" size={23} />
                </span>
                <h2>No weak matches were substituted</h2>
                <p>
                  The provider records did not contain enough verified business relevance and
                  customer-demand evidence. Future monitoring can add results when a stronger
                  conversation appears.
                </p>
              </section>
            )}
          </div>
        </section>
      )}

      {relevantConversations.length > 0 && (
        <section className={styles.dashboardSection}>
          <div className={styles.sectionHeadingRow}>
            <div>
              <span className={styles.eyebrow}>Relevant conversations</span>
              <h2>Demand evidence to learn from—not leads to contact</h2>
            </div>
            <span className={styles.qualityNote}>Kept separate from opportunity and reply counts</span>
          </div>
          <div className={styles.opportunityStack}>
            {relevantConversations.slice(0, 3).map((conversation) => (
              <RelevantConversationCard key={conversation.id} conversation={conversation} />
            ))}
          </div>
        </section>
      )}

      {availableReplyOpportunities[0] && (
        <section className={styles.dashboardSection}>
          <div className={styles.sectionHeadingRow}>
            <div>
              <span className={styles.eyebrow}>Suggested reply ready</span>
              <h2>Answer first, then add useful context</h2>
            </div>
            <span className={styles.qualityNote}>Grounded in verified website facts</span>
          </div>
          <ReplyComposer
            opportunity={availableReplyOpportunities[0]}
            value={
              drafts[availableReplyOpportunities[0].id] ??
              availableReplyOpportunities[0].reply.draft
            }
            isEditing={editingReplyId === availableReplyOpportunities[0].id}
            isCopied={copiedReplyId === availableReplyOpportunities[0].id}
            isPublished={publishedOpportunityIds.includes(availableReplyOpportunities[0].id)}
            onChange={(value) =>
              setDrafts((current) => ({
                ...current,
                [availableReplyOpportunities[0].id]: value,
              }))
            }
            onEdit={() =>
              setEditingReplyId((current) =>
                current === availableReplyOpportunities[0].id
                  ? null
                  : availableReplyOpportunities[0].id,
              )
            }
            onRegenerate={() => void regenerateReply(availableReplyOpportunities[0])}
            onCopy={() => void copyReply(availableReplyOpportunities[0].id)}
            onPublish={() => void publishReply(availableReplyOpportunities[0])}
            redditConnection={redditConnection}
          />
        </section>
      )}

      <div className={styles.twoColumnGrid}>
        <div className={styles.insightColumn}>
          {data.insights.slice(0, 2).map((insight) => (
            <DemandInsightCard key={insight.id} insight={insight} />
          ))}
        </div>
        <CompetitorWeaknessCard weakness={data.competitorWeaknesses[0]} />
      </div>

      {!hasFullAccess && (
        <LockedResultsPanel counts={data.lockedCounts} onUnlock={unlock} />
      )}
    </>
  );

  const renderOpportunities = () => (
    <>
      <SectionIntro
        eyebrow="Qualified conversations"
        title="Opportunities"
        description="Only conversations with a clear audience, problem or buying signal make this list. Technical query data and raw mentions stay hidden."
      />
      <div className={styles.filterRow}>
        <span className={styles.activeFilter}>Best match</span>
        <span>Buyer intent</span>
        <span>Low community risk</span>
        <span>Competitor signal</span>
      </div>
      <div className={styles.opportunityStack}>
        {data.opportunities.map((opportunity) => (
          <OpportunityCard
            key={opportunity.id}
            opportunity={opportunity}
            onOpenReply={openReply}
          />
        ))}
        {data.opportunities.length === 0 && (
          <section className={`${styles.card} ${styles.emptyResults}`}>
            <span className={styles.emptyResultsIcon}>
              <Icon name="opportunities" size={23} />
            </span>
            <h2>No qualified opportunities in this scan</h2>
            <p>
              Results are withheld when relevance or demand evidence is too weak. Raw mentions
              and low-confidence matches are never promoted into this list.
            </p>
          </section>
        )}
      </div>
      {!hasFullAccess && (
        <LockedResultsPanel
          counts={data.lockedCounts}
          context="section"
          onUnlock={unlock}
        />
      )}
    </>
  );

  const renderInsights = () => (
    <>
      <SectionIntro
        eyebrow={usesMockProvider ? "Demand patterns to validate" : "What customers are telling you"}
        title="Demand insights"
        description={
          usesMockProvider
            ? "Themes from qualified mock-provider conversations, clearly separated from live market evidence."
            : "Evidence-backed themes from qualified conversations, connected to a practical positioning or content action."
        }
      />
      <div className={styles.insightStack}>
        {data.insights.map((insight) => (
          <DemandInsightCard key={insight.id} insight={insight} />
        ))}
      </div>
      {relevantConversations.length > 0 && (
        <section className={styles.dashboardSection}>
          <div className={styles.sectionHeadingRow}>
            <div>
              <span className={styles.eyebrow}>Relevant conversations</span>
              <h2>Source-linked discussions behind the market picture</h2>
            </div>
            <span className={styles.qualityNote}>Not counted as potential customers</span>
          </div>
          <div className={styles.opportunityStack}>
            {relevantConversations.map((conversation) => (
              <RelevantConversationCard key={conversation.id} conversation={conversation} />
            ))}
          </div>
        </section>
      )}
      {!hasFullAccess && (
        <LockedResultsPanel
          counts={{
            ...data.lockedCounts,
            opportunities: 0,
            competitorSignals: 0,
            visibilityOpportunities: 0,
          }}
          context="section"
          onUnlock={unlock}
        />
      )}
    </>
  );

  const renderCompetitors = () => (
    <>
      <SectionIntro
        eyebrow="Where alternatives leave room"
        title="Competitor intelligence"
        description="Specific, carefully scoped signals—not a claim about broad market sentiment."
      />
      {data.competitorWeaknesses.map((weakness) => (
        <CompetitorWeaknessCard key={weakness.id} weakness={weakness} />
      ))}
      {!hasFullAccess && (
        <LockedResultsPanel
          counts={{
            ...data.lockedCounts,
            opportunities: 0,
            insights: 0,
            visibilityOpportunities: 0,
          }}
          context="section"
          onUnlock={unlock}
        />
      )}
    </>
  );

  const renderVisibility = () => (
    <>
      <SectionIntro
        eyebrow="Content gaps grounded in demand"
        title="Search & AI Visibility Opportunities"
        description="Useful questions the business can answer more clearly. No traffic, ranking or AI-citation claims are made without an external data provider."
      />
      <div className={styles.visibilityGrid}>
        {data.visibilityOpportunities.map((item, index) => (
          <article key={item.id} className={`${styles.card} ${styles.visibilityCard}`}>
            <span className={styles.visibilityNumber}>0{index + 1}</span>
            <h3>{item.title}</h3>
            <p>{item.summary}</p>
            <div className={styles.actionStrip}>
              <Icon name="arrow" size={15} />
              <p>{item.recommendedAction}</p>
            </div>
            <small>{item.verificationNote}</small>
          </article>
        ))}
      </div>
      {!hasFullAccess && (
        <LockedResultsPanel
          counts={{
            ...data.lockedCounts,
            opportunities: 0,
            insights: 0,
            competitorSignals: 0,
          }}
          context="section"
          onUnlock={unlock}
        />
      )}
    </>
  );

  const renderReplies = () => (
    <>
      <SectionIntro
        eyebrow="Ready for your review"
        title="Suggested replies"
        description="Every draft answers the conversation first, makes only source-backed product claims and discloses the business connection when relevant."
      />
      <div className={styles.replyWorkspace}>
        <aside className={styles.replyQueue} aria-label="Suggested reply queue">
          {availableReplyOpportunities.map((opportunity) => (
            <button
              key={opportunity.id}
              className={
                selectedOpportunity?.id === opportunity.id
                  ? styles.replyQueueActive
                  : ""
              }
              type="button"
              onClick={() => setSelectedOpportunityId(opportunity.id)}
            >
              <span>{opportunity.subreddit}</span>
              <strong>{opportunity.title}</strong>
              <small>{intentLabel(opportunity.classification.buyerIntent)}</small>
            </button>
          ))}
          {!hasFullAccess && (
            <button
              className={styles.replyQueueLocked}
              type="button"
              onClick={unlock}
            >
              <Icon name="lock" size={15} />
              <strong>{data.lockedCounts.readyReplies} more reply drafts</strong>
              <small>Unlock all stored replies</small>
            </button>
          )}
        </aside>
        {selectedOpportunity && (
          <ReplyComposer
            opportunity={selectedOpportunity}
            value={drafts[selectedOpportunity.id] ?? selectedOpportunity.reply.draft}
            isEditing={editingReplyId === selectedOpportunity.id}
            isCopied={copiedReplyId === selectedOpportunity.id}
            isPublished={publishedOpportunityIds.includes(selectedOpportunity.id)}
            onChange={(value) =>
              setDrafts((current) => ({
                ...current,
                [selectedOpportunity.id]: value,
              }))
            }
            onEdit={() =>
              setEditingReplyId((current) =>
                current === selectedOpportunity.id ? null : selectedOpportunity.id,
              )
            }
            onRegenerate={() => void regenerateReply(selectedOpportunity)}
            onCopy={() => copyReply(selectedOpportunity.id)}
            onPublish={() => void publishReply(selectedOpportunity)}
            redditConnection={redditConnection}
          />
        )}
      </div>
    </>
  );

  const renderResults = () => (
    <>
      <SectionIntro
        eyebrow="Participation outcomes"
        title="Results"
        description="Basic activity and conversion tracking for replies you record as published."
      />
      <div className={styles.metricsGridThree}>
        <MetricCard
          label="Published replies"
          value={metrics.publishedReplies}
          note="Recorded actions"
          tone="mint"
        />
        <MetricCard
          label="Tracked clicks"
          value={metrics.trackedClicks}
          note={metrics.trackedClicks ? "Verified workspace events" : "No verified clicks yet"}
          tone="violet"
        />
        <MetricCard
          label="Tracked conversions"
          value={metrics.trackedConversions}
          note={metrics.trackedConversions ? "Verified workspace events" : "No verified conversions yet"}
          tone="amber"
        />
      </div>
      <section className={`${styles.card} ${styles.emptyResults}`}>
        <span className={styles.emptyResultsIcon}>
          <Icon name="results" size={23} />
        </span>
        {publishedOpportunityIds.length === 0 ? (
          <>
            <h2>Your first verified result will appear here</h2>
            <p>
              Publish a useful reply, record its source and use a tracked link when it
              genuinely helps. Tracking starts at zero rather than inventing activity.
            </p>
            <button
              className={styles.secondaryButton}
              type="button"
              onClick={() => setActiveSection("replies")}
            >
              Review ready replies <Icon name="arrow" size={15} />
            </button>
          </>
        ) : accessLevel === "core" ? (
          <>
            <h2>Published reply recorded</h2>
            <p>Record only a click or customer outcome you can verify; attribution is never inferred.</p>
            <div className={styles.resultActions}>
              <button className={styles.secondaryButton} type="button" onClick={() => void recordClick()}>
                Record click <Icon name="arrow" size={15} />
              </button>
              <button className={styles.primaryButton} type="button" onClick={() => void recordConversion()}>
                Record conversion <Icon name="arrow" size={15} />
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>Published reply recorded</h2>
            <p>Basic click and conversion tracking is available on Core after an explicit purchase.</p>
            <button className={styles.secondaryButton} type="button" onClick={() => setActiveSection("billing")}>
              View Core <Icon name="arrow" size={15} />
            </button>
          </>
        )}
      </section>
    </>
  );

  const renderBilling = () => (
    <>
      <SectionIntro
        eyebrow="Simple launch pricing"
        title="Choose access that matches the work"
        description="No surprise fees, no automatic upgrade from the free scan and no access derived from a frontend redirect."
      />
      <div className={styles.pricingGrid}>
        {data.pricing.map((plan) => (
          <PricingCard
            key={plan.id}
            plan={plan}
            featured={plan.id === "full-access-pass"}
            onCheckout={onCheckout}
          />
        ))}
      </div>
      <p className={styles.billingFootnote}>
        Prices exclude VAT where applicable. Tax is calculated at Stripe Checkout.
        Stripe processing fees are not added as a separate customer charge.
      </p>
    </>
  );

  const renderSettings = () => (
    <>
      <SectionIntro
        eyebrow="One business, clear controls"
        title="Settings"
        description="Ordinary users see only the controls needed to keep monitoring relevant. Models, raw classifications and technical search details remain hidden."
      />
      <div className={styles.settingsGrid}>
        <section className={`${styles.card} ${styles.settingsCard}`}>
          <h3>Business</h3>
          <label>
            Website
            <input value={data.business.url} readOnly />
          </label>
          <label>
            Report name
            <input value={data.business.name} readOnly />
          </label>
          <small>
            {usesFictionalBusiness
              ? "Demo fields are read-only because the fixture is fictional."
              : "Profile fields are read-only after the source-backed analysis."}
          </small>
        </section>
        <section className={`${styles.card} ${styles.settingsCard}`}>
          <h3>Monitoring</h3>
          <label className={styles.switchRow}>
            <span>
              <strong>High-quality opportunities only</strong>
              <small>Hide weak matches and duplicate conversations.</small>
            </span>
            <input type="checkbox" checked readOnly aria-label="High quality only" />
          </label>
          <label className={styles.switchRow}>
            <span>
              <strong>Weekly summary</strong>
              <small>Only meaningful changes, not a raw mention digest.</small>
            </span>
            <input type="checkbox" checked readOnly aria-label="Weekly summary" />
          </label>
        </section>
        <section className={`${styles.card} ${styles.settingsCard}`}>
          <h3>Reddit publishing</h3>
          <p>
            <strong>
              {redditConnection.connected
                ? `Connected as u/${redditConnection.username}`
                : redditConnection.configured
                  ? "Reddit is ready to connect."
                  : "Direct Reddit connection is not configured."}
            </strong>
          </p>
          <small>
            {redditConnection.connected
              ? "Threadline requests identity and reply permission only. Every reply still requires an explicit click."
              : redditConnection.requiresPaidAccess
                ? "Unlock the Full Access Pass or Core first. Until then, Copy & open Reddit works for real source-linked opportunities."
                : redditConnection.configured
                  ? "Connect once, then post a reviewed reply to its exact source conversation."
                  : "Copy & open Reddit remains available for source-linked opportunities without OAuth."}
          </small>
          <div className={styles.settingsActions}>
            {redditConnection.connected ? (
              <button
                className={styles.secondaryButton}
                type="button"
                onClick={() => void onDisconnectReddit?.()}
              >
                Disconnect Reddit
              </button>
            ) : (
              <button
                className={styles.primaryButton}
                type="button"
                disabled={!redditConnection.canConnect}
                onClick={onConnectReddit}
              >
                Connect Reddit <Icon name="external" size={14} />
              </button>
            )}
          </div>
        </section>
      </div>
    </>
  );

  let content: React.ReactNode;
  if (activeSection === "dashboard") content = hasFullAccess ? renderDashboard() : renderMarketScan();
  else if (activeSection === "opportunities") content = renderOpportunities();
  else if (activeSection === "insights") content = renderInsights();
  else if (activeSection === "competitors") content = renderCompetitors();
  else if (activeSection === "visibility") content = renderVisibility();
  else if (activeSection === "replies") content = renderReplies();
  else if (activeSection === "results") content = renderResults();
  else if (activeSection === "billing") content = renderBilling();
  else content = renderSettings();

  return (
    <div className={styles.productShell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>
            <Icon name="logo" size={22} />
          </span>
          <div>
            <strong>Threadline</strong>
            <span>Demand intelligence</span>
          </div>
        </div>

        <div className={styles.workspaceSwitcher}>
          <span className={styles.workspaceAvatar} aria-hidden="true">
            {data.business.name.slice(0, 1).toUpperCase() || "T"}
          </span>
          <div>
            <strong>{data.business.name}</strong>
            <span>{data.business.hostname}</span>
          </div>
          <Icon name="arrow" size={14} />
        </div>

        <nav className={styles.navigation} aria-label="Primary navigation">
          {data.navigation.map((section) => (
            <button
              key={section.id}
              className={activeSection === section.id ? styles.navActive : ""}
              type="button"
              onClick={() => setActiveSection(section.id)}
            >
              <Icon name={section.id} size={17} />
              <span>{section.label}</span>
              {section.badge !== undefined && <small>{section.badge}</small>}
            </button>
          ))}
        </nav>

        <div className={styles.sidebarFooter}>
          <span className={styles.accessBadge}>{accessLabel(accessLevel)}</span>
          <p>
            {accessLevel === "free"
              ? "Unlock all stored findings for seven days."
              : "Access is active for this workspace."}
          </p>
          {accessLevel === "free" && (
            <button type="button" onClick={unlock}>
              {potentialCustomers.total > 0
                ? `See all ${potentialCustomers.total} opportunities — $12`
                : "Unlock full report — $12"} <Icon name="arrow" size={14} />
            </button>
          )}
        </div>
      </aside>

      <div className={styles.mainColumn}>
        <div className={styles.topbar}>
          <MockProviderNotice
            label={data.fixtureLabel}
            disclosure={fixtureDisclosure}
            compact
          />
          <div className={styles.topbarActions}>
            {onNewScan && (
              <button
                className={styles.newScanButton}
                type="button"
                onClick={onNewScan}
              >
                New scan
              </button>
            )}
            <span className={styles.lastScan}>
              {usesFictionalBusiness ? "Demo scan complete" : "Market Scan complete"}
            </span>
            <span className={styles.userAvatar} title="Private workspace" aria-label="Private workspace session">TL</span>
          </div>
        </div>
        <main className={styles.content}>
          {(hasFullAccess || activeSection !== "dashboard") && (
            <MockProviderNotice
              label={
                isFixtureFallbackForSubmittedDomain
                  ? `Fictional fallback fixture — not ${analyzedDomain}`
                  : data.fixtureLabel
              }
              disclosure={fixtureDisclosure}
            />
          )}
          {content}
        </main>
      </div>
    </div>
  );
}
