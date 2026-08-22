"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { REDDIT_MONITOR_LIMITS } from "@/lib/intelligence/reddit-monitor-limits";

import { redditDemandDemoData } from "./demo-data";
import type {
  BusinessProfile,
  ConversationTheme,
  NavigationSectionId,
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
  aiVisibility?: AiVisibilityStatus | null;
  onUpdateAiVisibility?: (enabled: boolean) => Promise<boolean>;
  onFunnelEvent?: (name: FunnelEventName) => Promise<void> | void;
}

function RedditMonitoringPanel({
  monitoring,
  onUpdate,
}: {
  monitoring: RedditMonitoringStatus | null;
  onUpdate?: ProductDashboardProps["onUpdateMonitoring"];
}) {
  const [terms, setTerms] = useState(() =>
    monitoring?.watchTerms
      .filter((term) => term.active)
      .slice(0, REDDIT_MONITOR_LIMITS.maxWatchTerms)
      .map((term) => term.value)
      .join("\n") ?? "",
  );
  const [saving, setSaving] = useState(false);
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
    </section>
  );
}

function AiVisibilityPanel({
  status,
  onUpdate,
}: {
  status: AiVisibilityStatus | null;
  onUpdate?: ProductDashboardProps["onUpdateAiVisibility"];
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
  isMostReliable,
  isRevealed,
  onToggleReply,
}: {
  conversation: RelevantConversation;
  isMostReliable: boolean;
  isRevealed: boolean;
  onToggleReply: () => void;
}) {
  const reliabilityScore = Math.round(conversation.reliabilityScore);
  const signalLabels = [...new Set([
    ...conversation.demandSignals,
    ...conversation.tags,
  ])].slice(0, 5);
  const hasReply = Boolean(conversation.reply?.draft.trim());

  return (
    <article className={styles.opportunityCard}>
      <div className={styles.carouselTopline}>
        {isMostReliable ? (
          <span className={styles.mostReliableBadge}>
            <Icon name="star" size={12} /> Most reliable
          </span>
        ) : (
          <span aria-hidden="true" />
        )}
        <span className={styles.reliabilityBadge}>
          <strong>{reliabilityScore}%</strong>
          <em>AI reliability</em>
        </span>
      </div>

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
      {hasReply && isRevealed && (
        <div className={styles.mockExcerpt}>
          <span>Suggested reply</span>
          <p>{conversation.reply?.draft}</p>
        </div>
      )}

      <div className={styles.carouselActions}>
        {hasReply && (
          <button className={styles.primaryButton} type="button" onClick={onToggleReply}>
            <Icon name="refresh" size={14} />
            {isRevealed ? "Hide suggested reply" : "Suggested reply ready"}
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
  isMostReliable,
  isRevealed,
  onToggleReply,
}: {
  opportunity: RedditOpportunity;
  isMostReliable: boolean;
  isRevealed: boolean;
  onToggleReply: () => void;
}) {
  const reliabilityScore = Math.round(opportunity.classification.relevanceScore);
  const tags = reliabilitySignalTags(opportunity);
  const whyItMatters = opportunity.matchReasons[0] ?? opportunity.classification.customerProblem;

  return (
    <article className={styles.opportunityCard}>
      <div className={styles.carouselTopline}>
        {isMostReliable ? (
          <span className={styles.mostReliableBadge}>
            <Icon name="star" size={12} /> Most reliable
          </span>
        ) : (
          <span aria-hidden="true" />
        )}
        <span className={styles.reliabilityBadge}>
          <strong>{reliabilityScore}%</strong>
          <em>AI reliability</em>
        </span>
      </div>

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
      aria-label="Relevant Reddit conversations, ordered by AI reliability, highest first"
    >
      {item.kind === "opportunity" ? (
        <CarouselOpportunityCard
          opportunity={item.opportunity}
          isMostReliable={safeIndex === 0}
          isRevealed={isRevealed}
          onToggleReply={() => toggleReply(item.id)}
        />
      ) : (
        <CarouselRelevantCard
          conversation={item.conversation}
          isMostReliable={safeIndex === 0}
          isRevealed={isRevealed}
          onToggleReply={() => toggleReply(item.id)}
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

      <div className={styles.carouselDots}>
        {items.map((dotItem, dotIndex) => (
          <button
            key={dotItem.id}
            type="button"
            className={`${styles.carouselDot} ${dotIndex === safeIndex ? styles.carouselDotActive : ""}`}
            aria-label={`Go to conversation ${dotIndex + 1} of ${total}`}
            aria-current={dotIndex === safeIndex ? "true" : undefined}
            onClick={() => goTo(dotIndex)}
          />
        ))}
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
  onNewScan,
  onRegenerateReply,
  onPublishOpportunity,
  redditConnection = {
    configured: false,
    connected: false,
    username: null,
    canConnect: false,
    requiresPaidAccess: true,
  },
  monitoring = null,
  onUpdateMonitoring,
  aiVisibility = null,
  onUpdateAiVisibility,
  onFunnelEvent,
}: ProductDashboardProps) {
  const data = scanResult ?? fixtureData;
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

  return (
    <div className={styles.productShell}>
      <header className={styles.minimalHeader}>
        <span className={styles.brandMark}>
          <Icon name="logo" size={18} />
        </span>
        <strong>Threadline</strong>
        <span className={styles.minimalHeaderSpacer} />
        {onNewScan && (
          <button className={styles.textButton} type="button" onClick={onNewScan}>
            New scan
          </button>
        )}
      </header>

      <main className={`${styles.content} ${styles.singleReport}`}>
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

        <BusinessProfilePanel profile={data.business} />

        <RedditMonitoringPanel
          key={monitoring
            ? `${monitoring.enabled}:${monitoring.watchTerms.map((term) => `${term.kind}:${term.active}:${term.value}`).join("|")}`
            : "monitoring-unavailable"}
          monitoring={monitoring}
          onUpdate={onUpdateMonitoring}
        />

        <AiVisibilityPanel
          key={aiVisibility ? `${aiVisibility.enabled}:${aiVisibility.nextRunAt}` : "ai-visibility-unavailable"}
          status={aiVisibility}
          onUpdate={onUpdateAiVisibility}
        />

        <section className={styles.dashboardSection}>
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
                    <span className={styles.eyebrow}>Relevant Reddit conversations</span>
                    <h2>{rankedOpportunities.length > 0 ? "Leads and other relevant conversations" : "Other relevant conversations"}</h2>
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
                />
              </TrackedSection>
            )
          )}
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
      </main>
    </div>
  );
}
