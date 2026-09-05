"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ProductDashboard,
  type RedditConnectionStatus,
  type RedditMonitoringStatus,
  type RedditMonitorRunSummary,
  type AiVisibilityStatus,
  type AiVisibilityScanSummary,
  type NavigationSectionId,
  type RedditOpportunity,
  type RelevantConversation,
} from "./demand-intelligence";
import {
  scanResponseToDashboard,
  type ApiPartialPreview,
  type ApiPartialResponse,
  type ApiScanResponse,
} from "./demand-intelligence/from-scan";
import {
  emptyLivePartialState,
  mergeLivePartialState,
  preserveLiveReplyEdits,
  refreshLiveResultOrder,
  type LivePartialState,
} from "./demand-intelligence/live-scan";
import { DiscoveryProfile } from "./DiscoveryProfile";
import { CompetitorsSetup } from "./CompetitorsSetup";
import { OnboardingHeader } from "./OnboardingHeader";
import styles from "./ThreadlineExperience.module.css";
import { startScanPolling, readScanResponse } from "@/lib/client/scan-polling";
import { scanElapsedMs, durationLabel, progressDetail } from "@/lib/client/scan-progress-view";

// Full analysis completes before the optional competitors step and review.
// There is no second analysis/refining wait and no timeout to a partial profile.
type View =
  | "landing"
  | "analyzing"
  | "competitors"
  | "profile"
  | "scanning"
  | "restoring"
  | "results"
  | "signup"
  | "done"
  | "report"
  | "error";
type AccessLevel = "free" | "pass" | "core";

/**
 * Daily Reddit monitoring and AI visibility tracking both run in the
 * background (a Postgres-backed scheduler polling every 60s / 5min, see
 * scripts/background-worker.mjs), completely independent of this
 * component's lifecycle. Without a repeating refetch here, a run that
 * finishes while the report tab is already open never becomes visible --
 * "Recent runs" / "Latest results" only updated on the one-time load that
 * fires when `view`/`accessLevel` change, so the only way to see a
 * newly-finished run was a manual page reload. This is deliberately much
 * slower than SCAN_POLL_INTERVAL_MS: these two panels change at most once
 * every 15 minutes-to-a-week, not multiple times a second.
 */
const BACKGROUND_STATUS_POLL_INTERVAL_MS = 20_000;

function keepStableScanUrl(scanId: string, remove: string[] = []) {
  const stable = new URL(window.location.href);
  for (const name of remove) stable.searchParams.delete(name);
  stable.searchParams.set("scan_id", scanId);
  window.history.replaceState({}, "", `${stable.pathname}${stable.search}`);
}

function clearStableScanUrl() {
  const setup = new URL(window.location.href);
  for (const name of ["scan_id", "checkout", "reddit"]) setup.searchParams.delete(name);
  window.history.replaceState({}, "", `${setup.pathname}${setup.search}`);
}

const disconnectedReddit: RedditConnectionStatus = {
  configured: false,
  connected: false,
  username: null,
  canConnect: false,
  requiresPaidAccess: true,
};

function effectiveAccessLevel(access: ApiScanResponse["access"] | undefined | null): AccessLevel {
  // Defense in depth: every scan response is supposed to include "access",
  // but a future endpoint that forgets it (as one already did) should
  // degrade to the free tier instead of crashing the whole page.
  return access?.unlocked ? access.plan : "free";
}

/**
 * Mirrors lib/server/scan-workflow.ts's STAGES exactly (id, label, detail)
 * -- the real backend pipeline the whole onboarding funnel is honest
 * about: one flat, seven-stage list. Used only as a fallback for a stage
 * `progress` hasn't reported yet; whenever the backend has an entry for a
 * given id, its label/detail always wins (see stageRows below).
 *
 * Two screens each show a slice of this same list rather than pretending
 * to be two separate pipelines: PRE_INPUT_STAGE_IDS is what can honestly
 * happen before the user has reviewed anything (the "analyzing" view),
 * POST_INPUT_STAGE_IDS is the Reddit-side work that only starts once
 * they've confirmed their keywords (the "scanning"/"restoring" view).
 */
const STAGE_META: Record<string, { label: string; detail: string }> = {
  website: {
    label: "Understanding your business",
    detail: "Reading safe public pages on the submitted domain.",
  },
  understanding: {
    label: "Mapping the problems you solve",
    detail: "Working out what you sell and who it's for.",
  },
  discovery: {
    label: "Searching the last year of Reddit",
    detail: "Searching your approved phrases for demand, pain, workarounds, switching and timing signals.",
  },
  triage: {
    label: "Reading every credible candidate",
    detail: "Filtering for genuine buying intent before reading full conversations.",
  },
  enrichment: {
    label: "Preparing evidence for deeper checks",
    detail: "Selecting conversations and preparing the available evidence.",
  },
  qualification: {
    label: "Identifying potential customers",
    detail: "Qualifying first, then ranking and deduplicating people by Reddit author.",
  },
  replies: {
    label: "Drafting a reply",
    detail: "Generating one grounded reply only when the conversation is appropriate to join.",
  },
};

const PRE_INPUT_STAGE_IDS = ["website", "understanding"];
const POST_INPUT_STAGE_IDS = ["discovery", "triage", "enrichment", "qualification", "replies"];

type StageStatus = "pending" | "active" | "complete" | "failed";

type StageRow = {
  id: string;
  label: string;
  detail: string;
  status: StageStatus;
};

/** Builds the rows for one screen's slice of the pipeline, real backend data first, static fallback second. */
function stageRowsFor(
  stageIds: string[],
  progress: ApiScanResponse["scan"]["progress"],
): StageRow[] {
  const reported = new Map(progress.map((item) => [item.id, item]));
  return stageIds.map((id) => {
    const real = reported.get(id);
    const meta = STAGE_META[id];
    return {
      id,
      label: real?.label ?? meta.label,
      detail: real?.detail ?? meta.detail,
      status: real?.status ?? "pending",
    };
  });
}

function useProgressClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function StageProgress({ rows, scan, connected }: { rows: StageRow[]; scan?: ApiScanResponse["scan"]; connected: boolean }) {
  const progress = scan?.runtimeProgress;
  const now = useProgressClock();
  const elapsed = scanElapsedMs(progress, now);
  const queued = scan?.phase === "analysis_queued" || scan?.phase === "scan_queued";
  const retrying = scan?.status === "retrying";
  const age = (time: string | null | undefined) => time && Number.isFinite(Date.parse(time)) ? durationLabel(now - Date.parse(time)) : null;
  const heartbeat = age(progress?.heartbeatAt), lastWork = age(progress?.lastWorkAt);
  const heartbeatDelayed = !!progress?.heartbeatAt && now - Date.parse(progress.heartbeatAt) > 90_000;
  // A stopped scan (scan.status === "failed") almost always also has a
  // stale heartbeat -- nothing is refreshing it anymore -- so this check
  // must come before heartbeatDelayed below, or a scan that has already
  // reached its terminal state keeps showing "checking for recovery"
  // forever even though nothing will ever recover it. See
  // lib/server/scan-execution.ts's ScanExecutionTimeoutError and
  // scripts/background-worker.mjs's TERMINAL_SCAN_ERROR_CODES: once a scan
  // lands on "failed" it is done, not paused.
  const stoppedForGood = scan?.status === "failed";
  const [copied, setCopied] = useState(false);
  const message = !connected ? "Connection interrupted. Showing the last saved status; reconnecting automatically."
    : queued ? "Accepted and waiting for an available worker."
    : retrying ? "A retry is scheduled. Completed work is saved."
    : !scan?.durable && (!scan || scan.phase === "created") ? "Confirming that background work has been accepted…"
    : stoppedForGood ? "This scan stopped and won't retry automatically. Saved progress below is still available."
    : heartbeatDelayed ? "No update in a while. Still working; saved progress is still available."
    : "Updates appear as each check finishes.";

  return (
    <>
      <p className={styles.progressStatus} role="status" aria-live="polite">{message}</p>
      <div className={styles.progressList} role="list" aria-label="Scan stages">
        {rows.map((row) => (
          <div
            className={`${styles.progressItem} ${row.status === "complete" ? styles.done : ""} ${row.status === "active" && !queued && !retrying ? styles.active : ""}`}
            key={row.id}
            role="listitem"
            aria-label={`${row.label}: ${queued && row.status !== "complete" ? "queued" : retrying && row.status === "active" ? "retry scheduled" : row.status}`}
          >
            <span aria-hidden="true">{row.status === "complete" ? "✓" : row.status === "active" && !queued ? "●" : "○"}</span>
            <div>
              <strong>{row.label}</strong>
              <small>{progressDetail(row.id, progress, row.detail)}</small>
            </div>
            {row.status === "active" && (
              <>
                <span className={styles.stageWorking}>{queued ? "queued" : retrying ? "retry scheduled" : "in progress"}</span>
                {!queued && !retrying && <i aria-hidden="true" />}
              </>
            )}
          </div>
        ))}
      </div>
      {progress && progress.insights !== "unknown" && rows.some(row => row.id === "qualification") && (
        <p className={styles.progressStatus}>Findings summary: {progress.insights === "fallback" ? "sourced fallback ready" : progress.insights === "active" ? "being prepared" : progress.insights}.</p>
      )}
      {elapsed !== null && !stoppedForGood && (
        <p className={styles.scanRunningLabel}>Scan running · {durationLabel(elapsed)}</p>
      )}
      <div className={styles.stageFooter}>
        {elapsed !== null && <span>Scan time: {durationLabel(elapsed)} · excludes time awaiting your review</span>}
        {lastWork && <span>Last saved progress: {lastWork} ago</span>}
        {heartbeat && <span>Worker last seen: {heartbeat} ago</span>}
      </div>
      <p className={styles.stageCloseNote}>{scan?.durable
        ? "You can leave this page. Your scan keeps running on the server -- return in this browser, or on another device if you signed in, and your saved progress will be waiting."
        : "Keep this tab open until background work is confirmed. This session has not confirmed durable acceptance."}</p>
      {scan?.durable && <button className={styles.returnLink} type="button" onClick={async () => {
        const link = new URL(window.location.pathname, window.location.origin); link.searchParams.set("scan_id", scan.id);
        setCopied(await copyText(link.toString()));
      }}>{copied ? "Return link copied" : "Copy private return link"}</button>}
    </>
  );
}

function safeDomain(value: string) {
  try {
    const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    return new URL(withProtocol).hostname.replace(/^www\./, "");
  } catch {
    return "your website";
  }
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // HTTP test hosts may not expose the Clipboard API; use the browser fallback.
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

export type LandingSubmission = { mode: "website"; websiteUrl: string } | { mode: "context"; contextText: string };

const MIN_CONTEXT_TEXT_LENGTH = 20;

const landingStatsBase = [
  { value: "100%", label: "Source-linked" },
  { value: "Live", label: "Opportunity monitoring" },
  { value: "94%", label: "Noise filtered out" },
];

const landingStepChips = ["social listening", "reddit monitoring", "lead discovery", "B2B SaaS"];

const landingFinds = [
  {
    tag: "buying",
    tone: "warm",
    title: "People asking what to buy",
    body: "Someone describing your exact problem and asking the room what they use. The warmest thing on the internet.",
    quote: "“Anyone found something that does this without the $900 price tag?”",
  },
  {
    tag: "switching",
    tone: "warm",
    title: "People leaving a competitor",
    body: "A public complaint about a tool you compete with, usually with a decision already made and nobody in the thread offering an answer.",
    quote: "“Cancelling next month. What did everyone move to?”",
  },
  {
    tag: "problem",
    tone: "neutral",
    title: "Problems they have not named yet",
    body: "They describe the pain but do not know a category exists. Educating here is how you get remembered.",
    quote: "“How do you even find out where people discuss your product?”",
  },
  {
    tag: "citable",
    tone: "brand",
    title: "Threads that become the answer",
    body: "High-traffic comparison threads that rank on Google and get quoted by AI assistants for years. Worth answering carefully.",
    quote: "“Best tools for a small marketing team — 2026 edition”",
  },
];

const landingRedditQuotes = [
  "“what does everyone actually use for this?”",
  "“looking for alternatives, budget is tight”",
  "“is it worth paying for or should we build it”",
  "“we tried three of these and hated all of them”",
];

const landingMonitorPoints = [
  "Your keywords, your brand and your competitors, checked around the clock.",
  "One digest a day, or a notification the moment something high-intent lands.",
  "Nothing shown twice, so the list is always what is actually new.",
];

const landingWeek = [
  { day: "Mon", title: "Paying $900/mo and getting nothing useful", sub: "r/SaaS · reply drafted", tag: "high" },
  { day: "Tue", title: "Finally cancelling our contract", sub: "r/marketing · competitor named", tag: "switch" },
  { day: "Wed", title: "Quiet day — nothing worth your time", sub: "412 conversations read, none kept", tag: "clear" },
  { day: "Thu", title: "How do you find where people talk about you?", sub: "r/smallbusiness · reply drafted", tag: "problem" },
  { day: "Fri", title: "Best listening tools — 2026 edition", sub: "r/marketing · 340 upvotes", tag: "citable" },
];

const landingVisibility = [
  { q: "“best reddit monitoring tool”", pct: 62 },
  { q: "“how to find leads on reddit”", pct: 41 },
  { q: "“alternatives to social listening tools”", pct: 18 },
];

const landingExampleWhy = [
  { label: "intent", text: "Asking for a recommendation outright." },
  { label: "fit", text: "Their complaint is the problem you solve." },
  { label: "timing", text: "Three hours old, 41 comments and climbing." },
  { label: "evidence", text: "Your pricing page answers their objection." },
];

const landingFreeFeatures = [
  "One full scan of your website",
  "Three opportunities in full, with sources",
  "One finished reply you can post",
  "Two demand insights and one competitor gap",
  "A count of everything else we found",
];

const landingCoreFeatures = [
  "Daily monitoring of keywords, brand and competitors",
  "Every opportunity, unlocked",
  "Unlimited drafted replies",
  "Competitor tracking with alerts",
  "Weekly AI visibility readings",
  "Up to three websites",
];

const landingFaq = [
  {
    q: "Is this just going to make me spam Reddit?",
    a: "No — and it would not work if it did. Every reply is drafted to answer the question that was actually asked, nothing is posted without you reading it, and if mentioning your product is relevant we add the disclosure. A reply that reads like an ad gets buried, which helps nobody.",
  },
  {
    q: "How do you choose which subreddits to watch?",
    a: "We do not restrict to specific subreddits -- we search across Reddit for terms drawn from your site (what you sell, the problems you solve, your competitors), and AI checks every match for relevance before anything is kept. You can edit those search terms any time from Monitoring config.",
  },
  {
    q: "Are these real conversations?",
    a: "Yes, and we label the source of every single one. If a result ever comes from a test fixture rather than live Reddit, it says so on the card. We would rather be boring about this than have you post into a thread that does not exist.",
  },
  {
    q: "What if my website does not explain much?",
    a: "Skip the crawl and use the \"Describe your market / idea\" tab instead -- a few honest sentences in your own words usually works better than a thin site. Either way, you get an editable profile of what we think you sell before anything runs, and correcting it is the single biggest improvement you can make to your results.",
  },
  {
    q: "Can I cancel?",
    a: "Yes, anytime, in one click from Billing. Cancel before day 7 of the trial and you are not charged anything; after that it is the regular monthly rate until you cancel.",
  },
];

const landingPreviewNav = [
  { label: "Overview", badge: "" },
  { label: "Opportunities", badge: "12", active: true },
  { label: "Conversations", badge: "48" },
  { label: "Competitors", badge: "3" },
  { label: "Insights", badge: "" },
  { label: "AI Visibility", badge: "" },
  { label: "Monitoring", badge: "on" },
  { label: "Replies", badge: "3" },
];

const landingPreviewThreads = [
  {
    sub: "r/SaaS",
    age: "3h",
    tag: "high intent",
    title: "Paying $900/mo for social listening and getting nothing useful",
    why: "Asking directly for an alternative, and named your category.",
    kept: true,
  },
  {
    sub: "r/marketing",
    age: "6h",
    tag: "switching",
    title: "Finally cancelling our contract — what's everyone moved to?",
    why: "Mentions a competitor you track, with a decision already made.",
  },
  {
    sub: "r/smallbusiness",
    age: "11h",
    tag: "problem",
    title: "How do you find out where people talk about your product?",
    why: "Describes the problem you solve, without knowing tools exist.",
  },
  {
    sub: "r/growmybusiness",
    age: "1d",
    tag: "researching",
    title: "Is Reddit actually worth the effort for B2B?",
    why: "Early-stage, but a good thread to be the useful answer in.",
  },
];

const landingPreviewWhy = [
  "They are asking for a recommendation, not just complaining.",
  "Your pricing page answers the objection they raised.",
  "The thread is three hours old — still worth replying to.",
];

function LandingBrand() {
  return (
    <span className={styles.slLogo}>
      <img src="/logos/scooptr-mark.png" alt="" className={styles.slLogoMark} />
      <span className={styles.slLogoText}>Scooptr</span>
    </span>
  );
}

type LandingAccount = { id: string; email: string; name: string | null };

function Landing({
  onSubmit,
  account,
  onSignOut,
}: {
  onSubmit: (submission: LandingSubmission) => void;
  // undefined = still checking; null = signed out; object = signed in.
  // Lifted to ThreadlineExperience so the post-scan Results/Signup/Done
  // steps can read the same account state this nav button already did --
  // see /api/auth/session and the google-oauth.ts sign-in flow it reads.
  account: LandingAccount | null | undefined;
  onSignOut: () => void;
}) {
  // Website and "describe your market / idea" are two equal ways in, not a
  // primary path and a fallback -- see the two-tab requirement this
  // implements. Website stays the default tab.
  const [mode, setMode] = useState<"website" | "context">("website");
  const [url, setUrl] = useState("");
  const [contextText, setContextText] = useState("");
  const [error, setError] = useState("");
  const [openFaq, setOpenFaq] = useState(0);

  // Real numbers, not marketing copy -- see app/api/public/landing-stats
  // and lib/server/public-stats-repository.ts. The endpoint just reads a
  // row a daily background job maintains, so this fetch is cheap and the
  // number is always true, unlike the hardcoded ones it replaced.
  const [publicStats, setPublicStats] = useState<{ scansAnalyzed: number; redditPostsAnalyzed: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/public/landing-stats")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled && data) setPublicStats(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const landingStats = useMemo(
    () => [
      landingStatsBase[0],
      {
        // "+" signals "at least this many, and growing" without
        // overclaiming precision -- the number itself stays real (see
        // app/api/public/landing-stats), never hardcoded.
        value: `${(publicStats?.redditPostsAnalyzed ?? 0).toLocaleString()}+`,
        label: "Posts analyzed",
      },
      landingStatsBase[1],
      landingStatsBase[2],
    ],
    [publicStats],
  );

  async function signOut() {
    onSignOut();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (mode === "website") {
      const candidate = url.trim();
      if (!candidate || !candidate.includes(".")) {
        setError("Enter a business website, like acme.com");
        return;
      }
      setError("");
      onSubmit({ mode: "website", websiteUrl: candidate });
      return;
    }
    const candidate = contextText.trim();
    if (candidate.length < MIN_CONTEXT_TEXT_LENGTH) {
      setError("Tell us a bit more -- a sentence or two about your business, market or idea.");
      return;
    }
    setError("");
    onSubmit({ mode: "context", contextText: candidate });
  }

  return (
    <>
      {/* Design handoff (design_handoff_scooptr) specifies Instrument Sans
       * and IBM Plex Mono; loaded here (rather than globally) so the rest
       * of the product experience keeps its existing Geist fonts -- see
       * "one surface at a time" scoping for this redesign. React 19
       * hoists these <link> tags into <head> automatically. */}
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link
        href="https://fonts.googleapis.com/css2?family=Instrument+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
        rel="stylesheet"
      />
      <main className={styles.slPage}>
        <nav className={styles.slNav}>
        <div className={styles.slNavInner}>
          <div className={styles.slNavBrand}>
            <LandingBrand />
          </div>
          <div className={styles.slNavLinks}>
            <a href="#how-it-works">How it works</a>
            <a href="#compounding">Product</a>
            <a href="#example">Examples</a>
            <a href="#pricing">Pricing</a>
          </div>
          <div className={styles.slNavRight}>
            {account ? (
              <div className={styles.slNavAccount}>
                <span className={styles.slNavAccountAvatar} aria-hidden="true">
                  {(account.name?.trim()?.[0] ?? account.email[0] ?? "?").toUpperCase()}
                </span>
                <span className={styles.slNavAccountLabel}>{account.name?.trim() || account.email}</span>
                <button type="button" className={styles.slNavSignOut} onClick={signOut}>
                  Sign out
                </button>
              </div>
            ) : (
              <a href="/api/auth/google/start" className={styles.slNavLogin}>
                Log in
              </a>
            )}
            <a href="#website-url" className={styles.slNavCta}>Scan my business</a>
          </div>
        </div>
      </nav>

      <section className={styles.slHero} id="top">
        <div className={styles.slHeroInner}>
          <span className={styles.slHeroEyebrow}>Reddit demand intelligence</span>

          <h1 className={styles.slHeroTitle}>
            Find people <span className={styles.slHeroTitleAccent}>already asking</span>
            <br />
            for what you sell.
          </h1>

          <p className={styles.slHeroLead}>
            Scooptr finds high-intent Reddit conversations, explains why they match your business,
            and drafts a reply you can make your own.
          </p>

          <form className={styles.slHeroForm} onSubmit={submit} noValidate>
            <div className={styles.slModeSwitch} role="tablist" aria-label="How to start your scan">
              <button
                type="button"
                role="tab"
                aria-selected={mode === "website"}
                className={mode === "website" ? `${styles.slModeBtn} ${styles.slModeBtnActive}` : styles.slModeBtn}
                onClick={() => {
                  setMode("website");
                  setError("");
                }}
              >
                Website
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "context"}
                className={mode === "context" ? `${styles.slModeBtn} ${styles.slModeBtnActive}` : styles.slModeBtn}
                onClick={() => {
                  setMode("context");
                  setError("");
                }}
              >
                Describe your market / idea
              </button>
            </div>

            {mode === "website" ? (
              <div className={styles.slUrlBar}>
                <span className={styles.slUrlProto}>https://</span>
                <input
                  id="website-url"
                  inputMode="url"
                  placeholder="yourcompany.com"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  aria-describedby={error ? "sl-url-error" : undefined}
                />
                <button type="submit" className={styles.slUrlSubmit}>
                  Scan my business <span aria-hidden="true">&#8594;</span>
                </button>
              </div>
            ) : (
              <div className={styles.slIdeaBox}>
                <textarea
                  id="market-context"
                  placeholder="A parental controls app for Android TV with daily time limits and no subscription."
                  value={contextText}
                  onChange={(event) => setContextText(event.target.value)}
                  aria-describedby={error ? "sl-url-error" : undefined}
                />
                <div className={styles.slIdeaFooter}>
                  <span className={styles.slIdeaNote}>No website needed &mdash; a couple of sentences is enough.</span>
                  <button type="submit" className={styles.slUrlSubmit}>
                    Scan my business <span aria-hidden="true">&#8594;</span>
                  </button>
                </div>
              </div>
            )}

            {error ? (
              <p className={styles.slFormError} id="sl-url-error">
                {error}
              </p>
            ) : (
              <p className={styles.slFormNote}>
                No card required &middot; Nothing posts without your approval
              </p>
            )}
          </form>

          <div className={styles.slSignalCard}>
            <div className={styles.slSignalMeta}>
              <span>r/SaaS &middot; 3h</span>
              <span className={`${styles.slSignalTag} ${styles.slSignalTagBlue}`}>High intent</span>
            </div>
            <p>&ldquo;Looking for an alternative to&hellip;&rdquo;</p>
          </div>
        </div>

        <div className={styles.slPreviewWrap}>
          <div className={styles.slPreviewFrame}>
            <div className={styles.slPreviewTopbar}>
              <span className={styles.slPreviewDots}>
                <i />
                <i />
                <i />
              </span>
              <span className={styles.slPreviewUrl}>scooptr.com/opportunities</span>
              <span className={styles.slPreviewBadge}>Interface preview</span>
            </div>
            <div className={styles.slPreviewGrid}>
              <div className={styles.slPreviewNav}>
                <div className={styles.slPreviewAccount}>
                  <span className={styles.slPreviewAccountMark}>AC</span>
                  <span>acme.io</span>
                </div>
                <div className={styles.slPreviewNavList}>
                  {landingPreviewNav.map((item) => (
                    <div
                      key={item.label}
                      className={
                        item.active
                          ? `${styles.slPreviewNavItem} ${styles.slPreviewNavItemActive}`
                          : styles.slPreviewNavItem
                      }
                    >
                      <span>{item.label}</span>
                      {item.badge ? <span className={styles.slPreviewNavBadge}>{item.badge}</span> : null}
                    </div>
                  ))}
                </div>
              </div>

              <div className={styles.slPreviewThreads}>
                <div className={styles.slPreviewThreadsHeader}>
                  <div>
                    <span>Opportunities</span>
                    <small>12 new since yesterday</small>
                  </div>
                  <span className={styles.slPreviewWatching}>watching</span>
                </div>
                {landingPreviewThreads.map((t) => (
                  <div
                    key={t.title}
                    className={
                      t.kept ? `${styles.slPreviewThreadItem} ${styles.slPreviewThreadItemKept}` : styles.slPreviewThreadItem
                    }
                  >
                    <div className={styles.slPreviewThreadMeta}>
                      <span>{t.sub}</span>
                      <span>{t.age}</span>
                      <span
                        className={styles.slPreviewThreadTag}
                        data-tag={t.tag === "high intent" || t.tag === "switching" ? "warm" : "neutral"}
                      >
                        {t.tag}
                      </span>
                    </div>
                    <span className={styles.slPreviewThreadTitle}>{t.title}</span>
                    <span className={styles.slPreviewThreadWhy}>{t.why}</span>
                  </div>
                ))}
              </div>

              <div className={styles.slPreviewReply}>
                <div className={styles.slPreviewReplyHeader}>
                  <span>Your reply</span>
                  <span>draft</span>
                </div>
                <div className={styles.slPreviewReplyBody}>
                  <div className={styles.slPreviewReplyCard}>
                    <div className={styles.slPreviewReplyAuthor}>
                      <span className={styles.slAvatarDot} data-tone="a" />
                      u/you
                    </div>
                    <p>
                      We hit the same wall around 40 seats. What actually changed it for us was moving off
                      per-seat pricing entirely &mdash; happy to explain how we set it up if it helps.
                    </p>
                  </div>
                  <div className={styles.slPreviewWhy}>
                    <span className={styles.slPreviewWhyLabel}>Why it matches</span>
                    {landingPreviewWhy.map((w) => (
                      <div key={w} className={styles.slPreviewWhyItem}>
                        <span className={styles.slPreviewWhyDot} />
                        {w}
                      </div>
                    ))}
                  </div>
                  <div className={styles.slPreviewActions}>
                    <span className={styles.slPreviewPost}>Post reply</span>
                    <span className={styles.slPreviewRewrite}>Rewrite</span>
                  </div>
                  <span className={styles.slPreviewFootnote}>
                    Nothing is ever posted until you read it and press post.
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.slStats}>
        <div className={styles.slStatsGrid}>
          {landingStats.map((s) => (
            <div key={s.label} className={styles.slStatItem}>
              <span className={styles.slStatValue}>{s.value}</span>
              <span className={styles.slStatLabel}>{s.label}</span>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.slSection} id="how-it-works">
        <div className={styles.slSectionInner}>
          <div className={styles.slSectionHead}>
            <span className={styles.slEyebrow}>[ how it works ]</span>
            <h2 className={styles.slSectionTitle}>Tell us what you sell. We do the reading. You hit send.</h2>
            <p className={styles.slSectionSubtitle}>Three steps, and only the third one needs you.</p>
          </div>

          <div className={styles.slHowGrid}>
            <div className={styles.slHowCard}>
              <span className={styles.slHowNum}>01</span>
              <h3>Tell us what you sell</h3>
              <p>
                Give us your website and we read a handful of pages, or just describe it in a sentence or
                two. You get to correct us before anything runs.
              </p>
              <div className={styles.slHowDemo}>
                <div className={styles.slHowDemoTabs}>
                  <span className={styles.slHowDemoTabActive}>Website</span>
                  <span>Describe it</span>
                </div>
                <div className={styles.slHowDemoUrlRow}>
                  <span className={styles.slHowDemoProto}>https://</span>
                  <span>acme.io</span>
                  <span className={styles.slHowDemoCursor} />
                </div>
                <div className={styles.slHowDemoChips}>
                  {landingStepChips.map((c) => (
                    <span key={c} className={styles.slHowDemoChip}>
                      {c}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className={styles.slHowCard}>
              <span className={styles.slHowNum}>02</span>
              <h3>We find the threads</h3>
              <p>
                Scooptr reads Reddit continuously and keeps only the conversations worth your time. Most of
                what it reads gets thrown away &mdash; that&rsquo;s the point.
              </p>
              <div className={styles.slHowDemo}>
                <div className={styles.slHowDemoReading}>
                  <span className={styles.slHowDemoReadingDot} />
                  <span>reading reddit</span>
                </div>
                <div className={styles.slHowDemoList}>
                  <div className={styles.slHowDemoRowFaded}>r/startups &middot; not relevant</div>
                  <div className={styles.slHowDemoRowFaded}>r/webdev &middot; not relevant</div>
                  <div className={styles.slHowDemoRowKept}>
                    <span className={styles.slHowDemoKeptTag}>r/marketing &middot; kept</span>
                    <span className={styles.slHowDemoKeptTitle}>Anyone happy with their listening stack?</span>
                  </div>
                </div>
              </div>
            </div>

            <div className={styles.slHowCard}>
              <span className={styles.slHowNum}>03</span>
              <h3>Join the conversation naturally</h3>
              <p>
                We turn each relevant thread into a contextual reply grounded in your business.
                Review it, edit anything you want, and post when it sounds like you.
              </p>
              <div className={styles.slHowDemo}>
                <div className={styles.slHowDemoReplyAuthor}>
                  <span className={styles.slAvatarDot} data-tone="a" />
                  u/you
                </div>
                <p className={styles.slHowDemoReplyText}>
                  We tried three different tools for this. What finally worked was keeping control of
                  the keyword list ourselves &mdash; it gave us much better results.
                  <span className={styles.slHowDemoCaret} />
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={`${styles.slSection} ${styles.slSectionMuted}`}>
        <div className={styles.slSectionInner}>
          <div className={styles.slSectionHeadLeft}>
            <span className={styles.slEyebrow}>[ what we find ]</span>
            <h2 className={styles.slSectionTitle}>Four kinds of conversation are worth your time</h2>
            <p className={styles.slSectionSubtitle}>Everything else is noise, and you never see it.</p>
          </div>
          <div className={styles.slFindsGrid}>
            {landingFinds.map((f) => (
              <div key={f.title} className={styles.slFindCard}>
                <span className={styles.slFindTag} data-tone={f.tone}>
                  {f.tag}
                </span>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
                <div className={styles.slFindQuote}>{f.quote}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className={styles.slSection}>
        <div className={styles.slWhyReddit}>
          <span className={styles.slEyebrow}>[ why reddit ]</span>
          <h2 className={styles.slSectionTitle}>
            People ask Reddit what to buy before they ask Google where to buy it
          </h2>
          <p className={styles.slSectionSubtitle}>
            By the time someone searches for a category, they&rsquo;ve usually already decided who to
            trust. That decision gets made in a thread, in their own words, weeks earlier &mdash; and
            it&rsquo;s the only place you can still influence it.
          </p>
          <div className={styles.slWhyRedditQuotes}>
            {landingRedditQuotes.map((q) => (
              <span key={q} className={styles.slWhyRedditQuote}>
                {q}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className={styles.slDark} id="compounding">
        <div className={styles.slSectionInner}>
          <div className={styles.slSectionHead}>
            <span className={styles.slEyebrowDark}>[ compounding ]</span>
            <h2 className={styles.slSectionTitleDark}>
              One reply. Three channels. It keeps paying long after the thread goes quiet.
            </h2>
            <p className={styles.slSectionSubtitleDark}>Answer the right thread once and it works three times over.</p>
          </div>

          <div className={styles.slCompoundGrid}>
            <div className={styles.slCompoundCard}>
              <div className={styles.slCompoundIconRow}>
                <img src="/logos/reddit.png" alt="Reddit" className={styles.slCompoundIcon} />
                <span>Engage on Reddit</span>
              </div>
              <div className={styles.slCompoundDemo}>
                <div className={styles.slEngageMeta}>
                  <span>r/saas</span>
                  <span>2h</span>
                </div>
                <span className={styles.slEngageTitle}>What are you all using for a 40 person team?</span>
                <div className={styles.slEngageDivider} />
                <div>
                  <div className={styles.slEngageReplyMeta}>u/you &middot; just now</div>
                  <p className={styles.slEngageReplyText}>
                    We hit the same wall at 40 seats. What fixed it was <strong>Scooptr</strong>.
                  </p>
                </div>
              </div>
              <h3>Same day, the click</h3>
              <p>
                The person asking is already shopping. They get a real answer, and so does everyone who
                lands on the thread after them.
              </p>
            </div>

            <div className={styles.slCompoundCard}>
              <div className={styles.slCompoundIconRow}>
                <img src="/logos/google.png" alt="Google" className={styles.slCompoundIcon} />
                <span>Rank on Google</span>
              </div>
              <div className={styles.slCompoundDemo}>
                <div className={styles.slRankChip}>best tool for a 40 person team</div>
                <div className={styles.slRankResult}>
                  <div className={styles.slRankResultTop}>
                    <span>reddit.com &middot; r/saas</span>
                    <span className={styles.slRankResultBadge}>#1</span>
                  </div>
                  <span className={styles.slRankResultTitle}>What are you all using for a 40 person team? : r/saas</span>
                  <span className={styles.slRankResultSnippet}>We hit the same wall at 40 seats. What&hellip;</span>
                </div>
              </div>
              <h3>Weeks later, the traffic</h3>
              <p>
                Reddit outranks most vendor pages. The thread keeps pulling in people who had never heard
                of you.
              </p>
            </div>

            <div className={styles.slCompoundCard}>
              <div className={styles.slCompoundIconRow}>
                <img
                  src="/logos/openai.png"
                  alt="ChatGPT"
                  className={`${styles.slCompoundIcon} ${styles.slCompoundIconOpenai}`}
                />
                <span>Get cited by AI</span>
              </div>
              <div className={styles.slCompoundDemo}>
                <div className={styles.slAiBubbleUser}>What should we use for a mid-size team?</div>
                <span className={styles.slAiAssistantLabel}>assistant</span>
                <p className={styles.slAiAssistantText}>
                  <strong>Scooptr</strong> is the one people keep coming back to for teams that size.
                </p>
                <span className={styles.slAiCited}>cited: reddit.com/r/saas</span>
              </div>
              <h3>Months later, you are the answer</h3>
              <p>
                Assistants lean on those threads when someone asks what to buy. The recommendation comes
                out of their mouth instead of yours.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.slSection}>
        <div className={styles.slMonitorGrid}>
          <div className={styles.slMonitorCopy}>
            <span className={styles.slEyebrow}>[ daily monitoring ]</span>
            <h2 className={styles.slSectionTitleSmall}>New conversations every day, while they&rsquo;re still live</h2>
            <p className={styles.slSectionSubtitle}>
              Whoever answers first usually wins the thread &mdash; and the Google ranking and the AI
              citation that follow it. Scooptr watches your keywords, your brand and your competitors
              around the clock, so you&rsquo;re the first real answer in the room instead of the reply
              that shows up three weeks after a competitor already got the click.
            </p>
            <div className={styles.slMonitorPoints}>
              {landingMonitorPoints.map((p) => (
                <div key={p} className={styles.slMonitorPoint}>
                  <span className={styles.slMonitorCheck}>&#10003;</span>
                  {p}
                </div>
              ))}
            </div>
          </div>
          <div className={styles.slMonitorCard}>
            <div className={styles.slMonitorCardHeader}>
              <span>This week</span>
              <span className={styles.slMonitorBadge}>monitoring on</span>
            </div>
            <div className={styles.slMonitorWeek}>
              {landingWeek.map((d) => (
                <div key={d.day} className={styles.slMonitorDay}>
                  <span className={styles.slMonitorDayLabel}>{d.day}</span>
                  <div className={styles.slMonitorDayBody}>
                    <span className={styles.slMonitorDayTitle}>{d.title}</span>
                    <span className={styles.slMonitorDaySub}>{d.sub}</span>
                  </div>
                  <span className={styles.slMonitorDayTag} data-tag={d.tag}>
                    {d.tag}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className={`${styles.slSection} ${styles.slSectionMuted}`}>
        <div className={styles.slTwoCol}>
          <div className={styles.slFeatureCard}>
            <span className={styles.slEyebrow} data-tone="warm">
              [ competitors ]
            </span>
            <h2 className={styles.slSectionTitleSmall}>
              When someone is unhappy with your competitor, be in that thread
            </h2>
            <p className={styles.slSectionSubtitle}>
              Somebody publicly asking for an alternative is the warmest lead on the internet. We watch
              every competitor you name and tell you the moment one of them comes up.
            </p>
            <div className={styles.slFeatureDemo}>
              <div className={styles.slCompetitorMeta}>
                <span>r/marketing &middot; 40m</span>
                <span className={styles.slCompetitorTag}>switching</span>
              </div>
              <span className={styles.slCompetitorTitle}>Finally cancelling our contract &mdash; what&rsquo;s everyone moved to?</span>
              <div className={styles.slCompetitorChips}>
                <span className={styles.slCompetitorChip}>mentions: competitor</span>
                <span className={styles.slCompetitorChip}>intent: high</span>
              </div>
            </div>
          </div>

          <div className={styles.slFeatureCard}>
            <span className={styles.slEyebrow}>[ ai visibility ]</span>
            <h2 className={styles.slSectionTitleSmall}>
              Find out whether assistants name you &mdash; and which threads made it happen
            </h2>
            <p className={styles.slSectionSubtitle}>
              Every week we ask the questions your buyers ask, record who gets named, and show you which
              Reddit threads the answer was built on.
            </p>
            <div className={styles.slFeatureDemo}>
              {landingVisibility.map((v) => (
                <div key={v.q} className={styles.slVisRow}>
                  <span className={styles.slVisQuestion}>{v.q}</span>
                  <span className={styles.slVisBarTrack}>
                    <span className={styles.slVisBarFill} style={{ width: `${v.pct}%` }} />
                  </span>
                  <span className={styles.slVisPct}>{v.pct}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className={styles.slSection} id="example">
        <div className={styles.slExample}>
          <div className={styles.slSectionHeadLeft}>
            <span className={styles.slEyebrow}>[ worked example ]</span>
            <h2 className={styles.slSectionTitleSmall}>Here&rsquo;s a real match, and the reply we drafted for it</h2>
            <p className={styles.slSectionSubtitle}>
              No engagement-bait, no fake enthusiasm, no link unless it genuinely answers the question. If
              a reply wouldn&rsquo;t survive the comment section, it isn&rsquo;t worth posting.
            </p>
          </div>

          <div className={styles.slExampleCard}>
            <div className={styles.slExampleHead}>
              <div className={styles.slExampleMeta}>
                <span>r/SaaS &middot; 3h &middot; 41 comments</span>
                <span className={styles.slExampleTag}>high intent</span>
              </div>
              <h3 className={styles.slExampleTitle}>
                Paying $900/mo for social listening and getting nothing useful out of it
              </h3>
              <p className={styles.slExampleBody}>
                &ldquo;Every alert is a false positive. I want to know when someone is actually asking for
                what we sell, not every time our category gets mentioned. Is there anything that does just
                that?&rdquo;
              </p>
            </div>
            <div className={styles.slExampleContent}>
              <div>
                <span className={styles.slExampleWhyLabel}>Why it matches your business</span>
                <div className={styles.slExampleWhyGrid}>
                  {landingExampleWhy.map((w) => (
                    <div key={w.label} className={styles.slExampleWhyItem}>
                      <span className={styles.slExampleWhyLabelSmall}>{w.label}</span>
                      <span className={styles.slExampleWhyText}>{w.text}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <span className={styles.slExampleWhyLabel}>Drafted reply</span>
                <div className={styles.slExampleReply}>
                  <div className={styles.slExampleReplyHeader}>
                    <span className={styles.slAvatarDot} data-tone="a" />
                    <span className={styles.slExampleReplyAuthor}>u/you</span>
                  </div>
                  <p className={styles.slExampleReplyText}>
                    We had the same problem at about half that spend. What actually helped was narrowing the
                    trigger from &ldquo;our category was mentioned&rdquo; to &ldquo;someone is asking for a
                    recommendation&rdquo; &mdash; the volume drops by maybe 95% and what&rsquo;s left is
                    worth reading. Happy to share the keyword set we ended up with if that&rsquo;s useful.
                  </p>
                  <div className={styles.slExampleReplyFooter}>disclosure added if you mention your product</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={`${styles.slSection} ${styles.slSectionMuted}`} id="pricing">
        <div className={styles.slPricing}>
          <div className={styles.slSectionHead}>
            <span className={styles.slEyebrow}>[ pricing ]</span>
            <h2 className={styles.slSectionTitle}>Your first scan is free. Then $30/mo to keep watching.</h2>
            <p className={styles.slSectionSubtitle}>
              One paid plan. Seven days free to see whether the daily conversations are worth it.
            </p>
          </div>

          <div className={styles.slPricingGrid}>
            <div className={styles.slPricingCard}>
              <div>
                <span className={styles.slPricingPlanName}>Free scan</span>
                <div className={styles.slPricingPrice}>
                  <span className={styles.slPricingPriceValue}>$0</span>
                  <span className={styles.slPricingPriceCadence}>once</span>
                </div>
                <span className={styles.slPricingSub}>No card, no account.</span>
              </div>
              <div className={styles.slPricingDivider} />
              <div className={styles.slPricingFeatures}>
                {landingFreeFeatures.map((f) => (
                  <div key={f} className={styles.slPricingFeature}>
                    <span className={styles.slPricingCheck}>&#10003;</span>
                    {f}
                  </div>
                ))}
              </div>
              <a href="#website-url" className={styles.slPricingCta}>
                Run a free scan
              </a>
            </div>

            <div className={styles.slPricingCardDark}>
              <span className={styles.slPricingBadge}>7 days free</span>
              <div>
                <span className={styles.slPricingPlanNameDark}>Core</span>
                <div className={styles.slPricingPrice}>
                  <span className={styles.slPricingPriceValueDark}>$30</span>
                  <span className={styles.slPricingPriceCadenceDark}>per month</span>
                </div>
                <span className={styles.slPricingSubDark}>Cancel any time, in one click.</span>
              </div>
              <div className={styles.slPricingDividerDark} />
              <div className={styles.slPricingFeatures}>
                {landingCoreFeatures.map((f) => (
                  <div key={f} className={styles.slPricingFeatureDark}>
                    <span className={styles.slPricingCheckDark}>&#10003;</span>
                    {f}
                  </div>
                ))}
              </div>
              <a href="#website-url" className={styles.slPricingCtaDark}>
                Start 7 days free
              </a>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.slSection}>
        <div className={styles.slFaq}>
          <div className={styles.slFaqHead}>
            <span className={styles.slEyebrow}>[ questions ]</span>
            <h2 className={styles.slSectionTitleSmall}>The things people actually ask</h2>
          </div>
          <div className={styles.slFaqList}>
            {landingFaq.map((item, i) => {
              const isOpen = openFaq === i;
              return (
                <div key={item.q} className={styles.slFaqItem}>
                  <button
                    type="button"
                    className={styles.slFaqButton}
                    onClick={() => setOpenFaq((current) => (current === i ? -1 : i))}
                    aria-expanded={isOpen}
                  >
                    <span className={styles.slFaqQuestion}>{item.q}</span>
                    <span className={styles.slFaqSign}>{isOpen ? "−" : "+"}</span>
                  </button>
                  {isOpen ? <p className={styles.slFaqAnswer}>{item.a}</p> : null}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className={styles.slClosing}>
        <h2 className={styles.slClosingTitle}>Put in your website. See who&rsquo;s asking for it.</h2>
        <p className={styles.slClosingLead}>
          Your first scan is free, with progress updates while it runs. No card, no account until you&rsquo;ve
          seen it.
        </p>
        <form className={styles.slClosingForm} onSubmit={submit} noValidate>
          <span className={styles.slUrlProto}>https://</span>
          <input
            inputMode="url"
            placeholder="yourcompany.com"
            value={url}
            onChange={(event) => {
              setMode("website");
              setUrl(event.target.value);
            }}
          />
          <button type="submit" className={styles.slUrlSubmit}>
            Scan my site
          </button>
        </form>
      </section>

      <footer className={styles.slFooter}>
        <div className={styles.slFooterInner}>
          <div className={styles.slFooterBrand}>
            <LandingBrand />
            <span className={styles.slFooterTagline}>Reddit demand, without the noise.</span>
          </div>
          <div className={styles.slFooterLinks}>
            <a href="#pricing">Pricing</a>
            <a href="#how-it-works">How it works</a>
            <a href="#top">Privacy</a>
            <a href="#top">Terms</a>
          </div>
        </div>
      </footer>
      </main>
    </>
  );
}

function Scanning({
  url,
  inputMode,
  progress,
  stepIndex,
  stageIds,
  scan,
  connected,
}: {
  url: string;
  inputMode: "website" | "context";
  progress: ApiScanResponse["scan"]["progress"];
  stepIndex: number;
  /** Which slice of the real pipeline this screen is honest about showing -- PRE_INPUT_STAGE_IDS or POST_INPUT_STAGE_IDS. */
  stageIds: string[];
  scan?: ApiScanResponse["scan"];
  connected: boolean;
}) {
  const isContext = inputMode === "context";
  const domain = useMemo(() => safeDomain(url), [url]);
  const rows = stageRowsFor(stageIds, progress).map(row => isContext && row.id === "website"
    ? { ...row, label: "Using your business description", detail: row.status === "complete" ? row.detail : "Using your description; no website crawl is needed." }
    : row);
  const allDone = rows.length > 0 && rows.every((row) => row.status === "complete");
  const isPreInput = stageIds === PRE_INPUT_STAGE_IDS;

  return (
    <main className={styles.scanScreen}>
      <OnboardingHeader activeIndex={stepIndex} />
      <section className={styles.scanPanel}>
        <div className={`${styles.scanVisual} ${allDone ? styles.scanVisualDone : ""}`} aria-hidden="true">
          <div className={styles.orbit}><i /><i /><i /></div>
          <span>↗</span>
        </div>
        <div className={styles.scanKicker}>{isPreInput ? (isContext ? "Analyzing your description" : `Analyzing ${domain}`) : "Your Market Scan"}</div>
        <h1>{isPreInput ? "Understanding your business" : "Finding and checking relevant conversations"}</h1>
        <p>
          {isPreInput
            ? "We’ll prepare the complete business profile for your review before searching Reddit."
            : "Search and AI response times vary. We keep the full search and review depth, and show completed checks below."}
        </p>
        <StageProgress
          rows={rows}
          scan={scan}
          connected={connected}
        />
        {!isContext && (
          <div className={styles.domainSafety}><span>⌁</span> Crawl boundary locked to <b>{domain}</b></div>
        )}
      </section>
    </main>
  );
}

function liveReplyLabel(state: "ready" | "pending" | "failed" | undefined): string {
  if (state === "ready") return "Reply ready";
  if (state === "failed") return "Reply needs another attempt";
  return "Reply being prepared";
}

// Derived from triage's own intent judgment -- not a fabricated match score.
// Full-context qualification (with a real percentage) has not run on these
// yet; that is exactly what "Qualification pending" already communicates.
function intentBadge(intent: ApiPartialPreview["intent"] | undefined): string | null {
  if (intent === "actively_looking" || intent === "switching") return "🔥 High intent";
  if (intent === "evaluating") return "Evaluating options";
  if (intent === "problem_aware") return "Problem aware";
  return null;
}

function LiveScanDashboard({
  url,
  inputMode,
  scan,
  progress,
  connected,
  partial,
  replyEdits,
  onReplyEdit,
  onRefreshOrder,
}: {
  url: string;
  inputMode: "website" | "context";
  scan?: ApiScanResponse["scan"];
  progress: ApiScanResponse["scan"]["progress"];
  connected: boolean;
  partial: LivePartialState;
  replyEdits: Record<string, string>;
  onReplyEdit: (replyId: string, value: string) => void;
  onRefreshOrder: () => void;
}) {
  const rows = stageRowsFor(POST_INPUT_STAGE_IDS, progress);
  const replyByOpportunity = new Map(partial.replies.map(reply => [reply.opportunityId, reply]));
  const replyStateByOpportunity = new Map(partial.replyStates.map(reply => [reply.opportunityId, reply.state]));
  const conversationCount = partial.opportunities.length + partial.relevantConversations.length;
  const reviewed = scan?.runtimeProgress?.triage.succeeded ?? partial.foundSoFar.reviewedCandidates;
  const stopped = scan?.status === "failed";
  const retrying = scan?.status === "retrying";
  const coverageIssue = (scan?.runtimeProgress?.queries.failed ?? 0) > 0
    || (scan?.runtimeProgress?.triage.unresolved ?? 0) > 0;
  const profile = scan?.approvedProfile;

  return (
    <main className={styles.liveScanPage}>
      <OnboardingHeader activeIndex={4} statusLabel={stopped ? "Partial scan saved" : "Market Scan running"} />
      <div className={styles.liveScanLayout}>
        <aside className={styles.liveScanSidebar}>
          <div className={styles.scanKicker}>{inputMode === "context" ? "Your market" : safeDomain(url)}</div>
          <h1>{stopped ? "Saved results from this scan" : "Results are arriving now"}</h1>
          <p>{stopped
            ? "The scan stopped before every check finished. Everything below passed its stated review stage and remains available."
            : "Keep reading while the remaining conversations are checked. New cards append without moving what you are viewing."}</p>
          {profile && (
            <section className={styles.liveProfile} aria-label="Approved business profile">
              <span>Searching for</span>
              <strong>{profile.name}</strong>
              <p>{profile.summary}</p>
              {profile.targetAudience.length > 0 && <small>{profile.targetAudience.slice(0, 3).join(" · ")}</small>}
            </section>
          )}
          <StageProgress rows={rows} scan={scan} connected={connected} />
        </aside>

        <section className={styles.liveResults} aria-label="Live scan results">
          <header className={styles.liveResultsHeader}>
            <div>
              <div className={styles.scanKicker}>Live, saved results</div>
              <h2>{stopped ? "Available findings" : "What we have found so far"}</h2>
              <p>These are interim counts, not the final scan totals.</p>
            </div>
            {partial.newResultsSinceOrder > 0 && (
              <button type="button" className={styles.liveRefreshOrder} onClick={onRefreshOrder}>
                Refresh order · {partial.newResultsSinceOrder} new
              </button>
            )}
          </header>

          <p className={styles.liveAnnouncement} role="status" aria-live="polite">
            {partial.newResultsSinceOrder > 0
              ? `${partial.newResultsSinceOrder} new result${partial.newResultsSinceOrder === 1 ? "" : "s"} ${partial.newResultsSinceOrder === 1 ? "was" : "were"} added below.`
              : stopped ? "Showing the latest safely saved findings." : "Waiting for the next saved result…"}
          </p>

          {(!connected || retrying || coverageIssue || stopped) && (
            <div className={styles.liveNotice} role="status">
              {!connected
                ? "Connection interrupted. The saved results below remain available while we reconnect."
                : retrying
                  ? "A retry is scheduled. Completed searches, reviews and replies have been saved."
                  : stopped
                    ? "Coverage is incomplete, so these findings are not presented as a definitive final report."
                    : "Some provider work is being retried. Ready results remain visible while coverage recovers."}
            </div>
          )}

          <div className={styles.liveMetrics} aria-label="Results found so far">
            <div><strong>{partial.foundSoFar.qualifiedPeople}</strong><span>potential customers found so far</span></div>
            <div><strong>{conversationCount}</strong><span>relevant conversations found so far</span></div>
            <div><strong>{reviewed ?? "—"}</strong><span>credible conversations checked</span></div>
            <div><strong>{partial.foundSoFar.repliesReady}</strong><span>replies ready so far</span></div>
          </div>

          {partial.previews.length > 0 && (
            <section className={styles.liveSection}>
              <div className={styles.liveSectionHeading}>
                <div><span>Screened, not yet qualified</span><h3>Conversations being checked</h3></div>
                <b>{partial.previews.length}</b>
              </div>
              <div className={styles.liveCardGrid}>
                {partial.previews.map(preview => {
                  const badge = intentBadge(preview.intent);
                  return (
                    <article className={`${styles.liveCard} ${styles.livePreviewCard}`} key={preview.id}>
                      <div className={styles.liveCardMeta}>
                        <span>r/{preview.subreddit.replace(/^r\//, "")}</span>
                        {badge ? <em className={styles.liveIntentBadge}>{badge}</em> : <em>Qualification pending</em>}
                      </div>
                      <h4>{preview.title}</h4>
                      <p>{preview.problem || preview.excerpt}</p>
                      <small>{preview.demandSignal.replaceAll("_", " ")} · {preview.productFit} product fit</small>
                    </article>
                  );
                })}
              </div>
            </section>
          )}

          {partial.opportunities.length > 0 && (
            <section className={styles.liveSection}>
              <div className={styles.liveSectionHeading}>
                <div><span>Deep review passed</span><h3>Potential customers</h3></div>
                <b>{partial.opportunities.length}</b>
              </div>
              <div className={styles.liveCardGrid}>
                {partial.opportunities.map(opportunity => {
                  const reply = replyByOpportunity.get(opportunity.id);
                  const replyState = replyStateByOpportunity.get(opportunity.id) ?? (reply ? "ready" : "pending");
                  return (
                    <article className={styles.liveCard} key={opportunity.id}>
                      <div className={styles.liveCardMeta}><span>r/{opportunity.subreddit.replace(/^r\//, "")}</span><em>Potential customer · {opportunity.qualificationScore}%</em></div>
                      <h4>{opportunity.title}</h4>
                      <p>{opportunity.whyItMatters}</p>
                      <small>{opportunity.author} · {opportunity.potentialCustomerIntent?.replaceAll("_", " ") ?? "qualified demand"}</small>
                      {opportunity.permalink && <a href={opportunity.permalink} target="_blank" rel="noreferrer">Open source conversation ↗</a>}
                      <div className={`${styles.liveReply} ${replyState === "failed" ? styles.liveReplyFailed : ""}`}>
                        <strong>{liveReplyLabel(replyState)}</strong>
                        {reply && replyState === "ready" ? (
                          <textarea aria-label={`Reply draft for ${opportunity.title}`} value={replyEdits[reply.id] ?? reply.content}
                            onChange={event => onReplyEdit(reply.id, event.target.value)} />
                        ) : <p>{replyState === "failed" ? "The saved conversation is still usable; reply generation can retry safely."
                          : replyState === "ready" ? "The reply is ready but its text is not included with the current access level."
                            : "The verified conversation is ready while its grounded draft is generated."}</p>}
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          )}

          {partial.relevantConversations.length > 0 && (
            <section className={styles.liveSection}>
              <div className={styles.liveSectionHeading}>
                <div><span>Useful evidence, not a lead</span><h3>Relevant conversations</h3></div>
                <b>{partial.relevantConversations.length}</b>
              </div>
              <div className={styles.liveCardGrid}>
                {partial.relevantConversations.map(conversation => {
                  const reply = replyByOpportunity.get(conversation.id);
                  const replyState = conversation.replyId
                    ? replyStateByOpportunity.get(conversation.id) ?? (reply ? "ready" : "pending")
                    : undefined;
                  return (
                    <article className={`${styles.liveCard} ${styles.liveRelevantCard}`} key={conversation.id}>
                      <div className={styles.liveCardMeta}><span>r/{conversation.subreddit.replace(/^r\//, "")}</span><em>Relevant conversation</em></div>
                      <h4>{conversation.title}</h4>
                      <p>{conversation.summary}</p>
                      <small>{conversation.author ?? "Reddit participant"} · not counted as a potential customer</small>
                      {conversation.permalink && <a href={conversation.permalink} target="_blank" rel="noreferrer">Open source conversation ↗</a>}
                      {conversation.replyId && (
                        <div className={`${styles.liveReply} ${replyState === "failed" ? styles.liveReplyFailed : ""}`}>
                          <strong>{liveReplyLabel(replyState)}</strong>
                          {reply && replyState === "ready" ? (
                            <textarea aria-label={`Reply draft for ${conversation.title}`} value={replyEdits[reply.id] ?? reply.content}
                              onChange={event => onReplyEdit(reply.id, event.target.value)} />
                          ) : <p>{replyState === "failed" ? "The conversation remains available without a draft."
                            : replyState === "ready" ? "The reply is ready but its text is not included with the current access level."
                              : "A grounded reply is being prepared independently of lead status."}</p>}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          )}

          {partial.previews.length === 0 && conversationCount === 0 && (
            <div className={styles.liveEmpty}>
              <div className={styles.orbit} aria-hidden="true"><i /><i /><i /></div>
              <h3>Reading the first credible conversations</h3>
              <p>Candidate previews appear only after relevance screening. Potential customers appear only after full-context qualification.</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

type ResultsItem =
  | { kind: "opportunity"; reliability: number; opportunity: RedditOpportunity }
  | { kind: "conversation"; reliability: number; conversation: RelevantConversation };

function buildResultsItems(data: NonNullable<ReturnType<typeof scanResponseToDashboard>>): ResultsItem[] {
  const opportunityItems: ResultsItem[] = data.opportunities.map((opportunity) => ({
    kind: "opportunity" as const,
    reliability: opportunity.classification.relevanceScore,
    opportunity,
  }));
  const conversationItems: ResultsItem[] = (data.relevantConversations ?? []).map((conversation) => ({
    kind: "conversation" as const,
    reliability: conversation.reliabilityScore,
    conversation,
  }));
  return [...opportunityItems, ...conversationItems].sort((a, b) => b.reliability - a.reliability);
}

type ResultMarketingSummary = {
  promisingConversations: number;
  qualifiedOpportunities: number;
  marketInsights: number;
  competitorSignals: number;
  readyReplies: number;
};

/**
 * The report intentionally contains more useful market intelligence than the
 * strict potential-customer table: relevant conversations and AI-shortlisted
 * candidates remain valuable even when conservative lead qualification does
 * not promote their authors. The conversion screens must describe that whole
 * delivered result, not call a useful 18-card report "0 opportunities".
 *
 * This mirrors ProductDashboard's carousel de-duplication by public Reddit URL
 * so the headline is both positive and auditable -- it never fabricates a
 * marketing number or counts the same conversation in three result buckets.
 */
function resultMarketingSummary(
  data: NonNullable<ReturnType<typeof scanResponseToDashboard>>,
): ResultMarketingSummary {
  const conversations = new Set<string>();
  const add = (kind: string, id: string, permalink?: string | null) => {
    conversations.add(permalink?.trim() || `${kind}:${id}`);
  };

  for (const opportunity of data.opportunities) {
    add("opportunity", opportunity.id, opportunity.permalink);
  }
  for (const conversation of data.relevantConversations ?? []) {
    add("conversation", conversation.id, conversation.permalink);
  }
  for (const candidate of data.scanEvidence?.candidates ?? []) {
    if (candidate.triage.worthEnriching) {
      add("candidate", candidate.externalId, candidate.permalink);
    }
  }

  return {
    promisingConversations: conversations.size,
    qualifiedOpportunities: data.metrics.qualifiedOpportunities,
    marketInsights: data.insights.length,
    competitorSignals: data.metrics.competitorSignals,
    readyReplies: data.metrics.readyReplies,
  };
}

/**
 * Step 6 in the design handoff's onboarding sequence. Sits between a
 * completed scan and the account-creation step -- shows the real strongest
 * match in full, then the rest as compact rows, so "keep these results" has
 * something concrete behind it before asking for an account. Every number
 * here comes from data.metrics / the ranked items themselves; nothing is
 * invented to match a target count.
 */
function ResultsPreview({
  data,
  domain,
  inputMode,
  onKeep,
}: {
  data: NonNullable<ReturnType<typeof scanResponseToDashboard>>;
  domain: string;
  inputMode: "website" | "context";
  onKeep: () => void;
}) {
  const items = useMemo(() => buildResultsItems(data), [data]);
  const summary = useMemo(() => resultMarketingSummary(data), [data]);
  const strongest = items[0];
  const rest = items.slice(1, 11);
  const { highIntentOpportunities } = data.metrics;

  return (
    <main className={styles.scanScreen}>
      <OnboardingHeader activeIndex={4} statusLabel="Results" />
      <section className={`${styles.scanPanel} ${styles.resultsPanel}`}>
        <div className={styles.scanKicker}>
          {inputMode === "context" ? "Scan complete" : `Scan complete · ${domain}`}
        </div>
        <h1>Here&apos;s what we found</h1>
        <p className={styles.resultsSummary}>
          {summary.promisingConversations > 0
            ? `${summary.promisingConversations} promising Reddit conversation${summary.promisingConversations === 1 ? "" : "s"} surfaced and ranked by relevance`
            : summary.marketInsights + summary.competitorSignals > 0
              ? `${summary.marketInsights + summary.competitorSignals} useful market finding${summary.marketInsights + summary.competitorSignals === 1 ? "" : "s"} surfaced`
              : "Your first market scan is ready for review"}
          {highIntentOpportunities > 0 ? `, including ${highIntentOpportunities} high-intent lead${highIntentOpportunities === 1 ? "" : "s"}` : ""}
          {summary.readyReplies > 0 ? `, with ${summary.readyReplies} repl${summary.readyReplies === 1 ? "y" : "ies"} ready to use` : ""}.
        </p>

        {strongest && (
          <div className={styles.resultsPrimaryCard}>
            {strongest.kind === "opportunity" ? (
              <>
                <span className={styles.resultsPrimaryMeta}>
                  {strongest.opportunity.subreddit} &middot; {strongest.opportunity.authorLabel}
                </span>
                <h2 className={styles.resultsPrimaryTitle}>{strongest.opportunity.title}</h2>
                {strongest.opportunity.matchReasons[0] && (
                  <p className={styles.resultsPrimaryWhy}>{strongest.opportunity.matchReasons[0]}</p>
                )}
                {strongest.opportunity.reply?.draft && (
                  <p className={styles.resultsPrimaryReply}>{strongest.opportunity.reply.draft}</p>
                )}
              </>
            ) : (
              <>
                <span className={styles.resultsPrimaryMeta}>
                  {strongest.conversation.subreddit} &middot; {strongest.conversation.authorLabel}
                </span>
                <h2 className={styles.resultsPrimaryTitle}>{strongest.conversation.title}</h2>
                <p className={styles.resultsPrimaryWhy}>{strongest.conversation.summary}</p>
              </>
            )}
          </div>
        )}

        {rest.length > 0 && (
          <div className={styles.resultsRowList}>
            {rest.map((item) =>
              item.kind === "opportunity" ? (
                <div className={styles.resultsRow} key={`opportunity-${item.opportunity.id}`}>
                  <span className={styles.resultsRowSub}>{item.opportunity.subreddit}</span>
                  <span className={styles.resultsRowTitle}>{item.opportunity.title}</span>
                </div>
              ) : (
                <div className={styles.resultsRow} key={`conversation-${item.conversation.id}`}>
                  <span className={styles.resultsRowSub}>{item.conversation.subreddit}</span>
                  <span className={styles.resultsRowTitle}>{item.conversation.title}</span>
                </div>
              ),
            )}
          </div>
        )}

        <p className={styles.resultsFooterNote}>
          These stay on this browser for 30 days unless you keep them.
        </p>
        <button className={styles.tryAgain} type="button" onClick={onKeep} style={{ background: "var(--green)", color: "#fff", borderColor: "var(--green)" }}>
          Keep these results
        </button>
      </section>
    </main>
  );
}

/**
 * Step 7. Reuses the exact same /api/auth/google/start -> callback round
 * trip the landing nav's "Log in" link already drives (see google-oauth.ts
 * and completeGoogleSignIn) -- this screen does not implement its own auth,
 * it just asks at the moment it matters. Skipping is real: the anonymous
 * workspace already keeps results for 30 days on its own, so this is an
 * upgrade to permanent storage, not a gate on seeing them.
 */
function SignupGate({
  data,
  onSkip,
}: {
  data: NonNullable<ReturnType<typeof scanResponseToDashboard>>;
  onSkip: () => void;
}) {
  const summary = useMemo(() => resultMarketingSummary(data), [data]);
  const usefulFindings = summary.marketInsights + summary.competitorSignals;
  const highlights = [
    summary.promisingConversations > 0
      ? `${summary.promisingConversations} promising conversation${summary.promisingConversations === 1 ? "" : "s"}`
      : "",
    summary.qualifiedOpportunities > 0
      ? `${summary.qualifiedOpportunities} qualified lead${summary.qualifiedOpportunities === 1 ? "" : "s"}`
      : "",
    summary.marketInsights > 0
      ? `${summary.marketInsights} market insight${summary.marketInsights === 1 ? "" : "s"}`
      : "",
    summary.competitorSignals > 0
      ? `${summary.competitorSignals} competitor signal${summary.competitorSignals === 1 ? "" : "s"}`
      : "",
    summary.readyReplies > 0
      ? `${summary.readyReplies} ready-to-use repl${summary.readyReplies === 1 ? "y" : "ies"}`
      : "",
  ].filter(Boolean);

  return (
    <main className={styles.scanScreen}>
      <OnboardingHeader activeIndex={4} />
      <section className={`${styles.scanPanel} ${styles.signupPanel}`}>
        <div className={styles.scanKicker}>Your market intelligence is ready</div>
        <h1>
          {summary.promisingConversations > 0
            ? `We found ${summary.promisingConversations} promising Reddit conversation${summary.promisingConversations === 1 ? "" : "s"}`
            : usefulFindings > 0
              ? `We uncovered ${usefulFindings} useful market finding${usefulFindings === 1 ? "" : "s"}`
              : "Your first market scan is complete"}
        </h1>
        {highlights.length > 0 && (
          <ul className={styles.signupHighlights} aria-label="Scan result summary">
            {highlights.map((highlight) => <li key={highlight}>{highlight}</li>)}
          </ul>
        )}
        <p>
          Create your free workspace to keep the complete report permanently and have one place to
          turn on ongoing demand monitoring when you are ready. Choosing a paid plan is a separate decision.
        </p>
        <a href="/api/auth/google/start" className={styles.signupGoogleButton}>
          <span aria-hidden="true">G</span> Save results with Google
        </a>
        <button type="button" className={styles.signupSkipLink} onClick={onSkip}>
          Continue without an account
        </button>
      </section>
    </main>
  );
}

/**
 * Step 8. Reached either after a real Google sign-in redirect round trip
 * (see the justSignedIn handling in ThreadlineExperience's mount effect) or
 * after choosing "continue without an account" on SignupGate -- copy
 * adapts to which one happened rather than assuming.
 */
function DoneConfirmation({
  signedIn,
  onGoToOpportunities,
  onSeePlans,
}: {
  signedIn: boolean;
  onGoToOpportunities: () => void;
  onSeePlans: () => void;
}) {
  return (
    <main className={styles.scanScreen}>
      <OnboardingHeader activeIndex={4} />
      <section className={`${styles.scanPanel} ${styles.donePanel}`}>
        <div className={styles.doneMark} aria-hidden="true">&#10003;</div>
        <h1>{signedIn ? "Your account is set up" : "You're set for now"}</h1>
        <p>
          {signedIn
            ? "Your results are saved to your account. Monitoring stays off until you pick a plan."
            : "Your results are saved to this browser for 30 days. Sign in any time from the top of the page to keep them longer."}
        </p>
        <div className={styles.doneActions}>
          <button
            className={styles.tryAgain}
            type="button"
            onClick={onGoToOpportunities}
            style={{ background: "var(--green)", color: "#fff", borderColor: "var(--green)" }}
          >
            Go to my opportunities
          </button>
          <button className={styles.signupSkipLink} type="button" onClick={onSeePlans}>
            See plans
          </button>
        </div>
      </section>
    </main>
  );
}

export function ThreadlineExperience() {
  const [view, setView] = useState<View>("landing");
  const [url, setUrl] = useState("");
  /** "context" scans have no websiteUrl (it stays "") -- see ScanRecord.inputMode. */
  const [inputMode, setInputMode] = useState<"website" | "context">("website");
  const [contextText, setContextText] = useState("");
  const [scanResponse, setScanResponse] = useState<ApiScanResponse | null>(null);
  const [scanProgress, setScanProgress] = useState<ApiScanResponse["scan"]["progress"]>([]);
  /** Set once the website is analyzed and the profile is awaiting review. */
  const [reviewScanId, setReviewScanId] = useState("");
  const [accessLevel, setAccessLevel] = useState<AccessLevel>("free");
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [scanConnected, setScanConnected] = useState(true);
  const [livePartial, setLivePartial] = useState<LivePartialState | null>(null);
  const [liveReplyEdits, setLiveReplyEdits] = useState<Record<string, string>>({});
  const navigationVersionRef = useRef(0);
  const resumedScanRef = useRef<ApiScanResponse | null>(null);
  const partialScanIdRef = useRef("");
  const partialVersionRef = useRef(0);
  const partialHasVisibleResultsRef = useRef(false);
  // Reuse the same creation promise across effect restarts; never create on polling.
  const analysisScanRef = useRef<Promise<ApiScanResponse> | null>(null);
  const [redditConnection, setRedditConnection] =
    useState<RedditConnectionStatus>(disconnectedReddit);
  const [monitoring, setMonitoring] = useState<RedditMonitoringStatus | null>(null);
  const [monitorRuns, setMonitorRuns] = useState<RedditMonitorRunSummary[] | null>(null);
  const [aiVisibility, setAiVisibility] = useState<AiVisibilityStatus | null>(null);
  const [visibilityScans, setVisibilityScans] = useState<AiVisibilityScanSummary[] | null>(null);
  // undefined = still checking; null = signed out; object = signed in. Read
  // once on mount (in parallel with the latest-scan restore below) and kept
  // here, not inside Landing, because the post-scan Results/Signup/Done
  // steps need it too -- see /api/auth/session and google-oauth.ts.
  const [account, setAccount] = useState<LandingAccount | null | undefined>(undefined);
  const [reportInitialSection, setReportInitialSection] = useState<NavigationSectionId>("dashboard");
  // Read inside the scan-polling effect below without adding `account` to
  // its dependency array -- that effect creates/polls a scan as a side
  // effect, so re-running it just because the account fetch resolved
  // (undefined -> null/object, shortly after mount) would risk restarting
  // an in-flight scan. This mirrors it live without gating the effect on it.
  const accountRef = useRef(account);
  useEffect(() => {
    accountRef.current = account;
  }, [account]);

  async function fetchAccountProfile(): Promise<LandingAccount | null> {
    try {
      const response = await fetch("/api/auth/session", { cache: "no-store" });
      const payload = (await response.json()) as { user: LandingAccount | null };
      return payload.user;
    } catch {
      return null;
    }
  }

  async function signOutAccount() {
    setAccount(null);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Best-effort -- the client already reflects signed-out state either
      // way, and the session cookie is HttpOnly so there's nothing else to
      // clean up here even if the request failed.
    }
  }
  const dashboardData = useMemo(() => {
    const complete = scanResponse ? scanResponseToDashboard(scanResponse) : null;
    return preserveLiveReplyEdits(complete, liveReplyEdits);
  }, [scanResponse, liveReplyEdits]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkoutState = params.get("checkout");
    const redditState = params.get("reddit");
    const scanId = params.get("scan_id");
    // Set by /api/auth/google/callback right after a successful sign-in
    // round trip. The fetch to /api/auth/session below (not this param) is
    // the source of truth for account state -- this only tells us whether
    // we just came back from that redirect, to decide "done" vs "report".
    const justSignedIn = params.get("account") === "connected";
    let cancelled = false;
    let pollTimer = 0;

    if (typeof window !== "undefined" && window.location.search.includes("account=")) {
      const cleanedUrl = new URL(window.location.href);
      cleanedUrl.searchParams.delete("account");
      window.history.replaceState({}, "", `${cleanedUrl.pathname}${cleanedUrl.search}`);
    }

    if (redditState) {
      queueMicrotask(() => {
        if (cancelled) return;
        if (redditState === "connected") {
          setStatusMessage("Reddit connected. Reviewed replies can now be posted directly.");
        } else if (redditState === "denied") {
          setStatusMessage("Reddit connection was canceled. Copy & open Reddit still works.");
        } else if (redditState === "error") {
          setStatusMessage("Reddit could not be connected. Copy & open Reddit still works.");
        }
      });
    }
    if (redditState) {
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete("reddit");
      window.history.replaceState({}, "", `${cleanUrl.pathname}${cleanUrl.search}`);
    }

    if (!scanId || (checkoutState !== "success" && checkoutState !== "canceled")) {
      const navigationVersion = navigationVersionRef.current;
      const accountRequest = fetchAccountProfile();
      void accountRequest.then(userAccount => {
        if (!cancelled && navigationVersion === navigationVersionRef.current) setAccount(userAccount);
      });
      if (scanId) queueMicrotask(() => { if (!cancelled && navigationVersion === navigationVersionRef.current) setView("restoring"); });
      const restoration = startScanPolling({
        onConnectionChange: setScanConnected,
        onError: error => {
          if (cancelled || navigationVersion !== navigationVersionRef.current || !scanId) return;
          setErrorMessage(error instanceof Error ? error.message : "The saved scan could not be opened.");
          setView("error");
        },
        run: async signal => {
          if (navigationVersion !== navigationVersionRef.current) return true;
          const response = await fetch(scanId ? `/api/scans/${encodeURIComponent(scanId)}` : "/api/scans/latest", { cache: "no-store", signal });
          if (!scanId && (response.status === 401 || response.status === 404)) return true;
          const latest = await readScanResponse<ApiScanResponse>(response);
          signal.throwIfAborted();
          if (cancelled || navigationVersion !== navigationVersionRef.current) return true;
          if (!latest.scan?.id) throw new TypeError("The saved status is temporarily unavailable.");
          setUrl(latest.scan.websiteUrl);
          setInputMode(latest.scan.inputMode ?? "website");
          setContextText(latest.scan.contextText ?? "");
          resumedScanRef.current = latest;
          setScanResponse(latest);
          setScanProgress(latest.scan.progress);
          setAccessLevel(effectiveAccessLevel(latest.access));
          setReviewScanId(latest.scan.id);
          keepStableScanUrl(latest.scan.id);
          if (latest.scan.status === "failed") {
            setErrorMessage(latest.scan.error ?? "The latest Market Scan stopped before every check finished.");
            setView((latest.scan.runtimeProgress?.partialResultsVersion ?? 0) > 0 ? "scanning" : "error");
          } else if (latest.scan.status === "complete" && latest.report) {
            // A signed-in visitor (returning, or just back from the Google
            // redirect) skips straight past the results/signup gate -- it
            // only exists to get an anonymous scan claimed by an account in
            // the first place. justSignedIn distinguishes "just completed
            // that round trip, show a confirmation" from "ordinary reload
            // of an already-claimed workspace, go straight to the report".
            const userAccount = await accountRequest;
            signal.throwIfAborted();
            if (cancelled || navigationVersion !== navigationVersionRef.current) return true;
            setView(userAccount ? (justSignedIn ? "done" : "report") : "results");
          } else if (latest.scan.phase === "awaiting_review") {
            if (!latest.scan.analysisReady) throw new Error("This older scan has an incomplete profile. Start a new scan to review the full analysis.");
            setView("competitors");
          } else if (["created", "analysis_queued", "analyzing"].includes(latest.scan.phase ?? "")) {
            analysisScanRef.current = Promise.resolve(latest);
            setView("analyzing");
          } else {
            setView("scanning");
          }
          return true;
        },
      });
      return () => {
        cancelled = true;
        restoration.stop();
      };
    }
    const restoredScanId = scanId;

    async function restoreCheckoutScan() {
      setView("restoring");
      setStatusMessage(
        checkoutState === "success"
          ? "Confirming payment from Stripe’s verified webhook…"
          : "Checkout canceled. Restoring your free Market Scan…",
      );

      const maxAttempts = checkoutState === "success" ? 30 : 1;
      try {
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          const response = await fetch(`/api/scans/${encodeURIComponent(restoredScanId)}`, {
            cache: "no-store",
          });
          const latest = (await response.json()) as ApiScanResponse;
          if (!response.ok || !latest.scan?.id) {
            throw new Error(latest.error?.message ?? "Your Market Scan could not be restored.");
          }
          if (cancelled) return;

          setUrl(latest.scan.websiteUrl);
          setInputMode(latest.scan.inputMode ?? "website");
          setContextText(latest.scan.contextText ?? "");
          setScanResponse(latest);
          setScanProgress(latest.scan.progress);
          setAccessLevel(effectiveAccessLevel(latest.access));

          if (latest.scan.status === "failed") {
            setErrorMessage(latest.scan.error ?? "The scan stopped before completion.");
            if ((latest.scan.runtimeProgress?.partialResultsVersion ?? 0) > 0) {
              resumedScanRef.current = latest;
              setView("scanning");
              return;
            }
            throw new Error(latest.scan.error ?? "The scan stopped before completion.");
          }
          if (latest.scan.status === "complete" && latest.report) {
            setView("report");
          }

          if (checkoutState === "canceled") {
            setStatusMessage("Checkout canceled. Your free Market Scan is still available.");
            keepStableScanUrl(restoredScanId, ["checkout"]);
            return;
          }
          if (latest.access?.unlocked && latest.access.verifiedByWebhook) {
            setStatusMessage(
              latest.access.plan === "core"
                ? "Core is active from a verified Stripe webhook."
                : "Your 7-day pass is active from a verified Stripe webhook.",
            );
            keepStableScanUrl(restoredScanId, ["checkout"]);
            return;
          }

          await new Promise<void>((resolve) => {
            pollTimer = window.setTimeout(resolve, 500);
          });
          if (cancelled) return;
        }

        setStatusMessage(
          "Stripe is still confirming payment. Keep this report open or refresh to check the verified webhook again.",
        );
      } catch (error) {
        if (cancelled) return;
        setErrorMessage(
          error instanceof Error ? error.message : "Your Market Scan could not be restored.",
        );
        setView("error");
      }
    }

    void restoreCheckoutScan();
    return () => {
      cancelled = true;
      window.clearTimeout(pollTimer);
    };
  }, []);

  useEffect(() => {
    const scanId: string | undefined = scanResponse?.scan.id;
    if (view !== "report" || !scanId) return;
    const activeScanId: string = scanId;
    let cancelled = false;
    async function loadRedditConnection() {
      try {
        const response = await fetch("/api/reddit/status", { cache: "no-store" });
        const payload = (await response.json()) as {
          reddit?: RedditConnectionStatus;
        };
        if (response.ok && payload.reddit && !cancelled) {
          setRedditConnection(payload.reddit);
        }
      } catch {
        if (!cancelled) setRedditConnection(disconnectedReddit);
      }
    }

    async function loadRedditMonitoring() {
      try {
        const response = await fetch(`/api/monitoring/settings?scanId=${encodeURIComponent(activeScanId)}`, { cache: "no-store" });
        const payload = (await response.json()) as {
          monitoring?: RedditMonitoringStatus;
          recentRuns?: RedditMonitorRunSummary[];
        };
        if (response.ok && payload.monitoring && !cancelled) {
          setMonitoring(payload.monitoring);
          setMonitorRuns(payload.recentRuns ?? []);
        }
      } catch {
        // Monitoring is independent from Reddit OAuth. A transient settings
        // error must not change the separately loaded connection state.
      }
    }

    async function loadAiVisibility() {
      try {
        const response = await fetch(`/api/ai-visibility/settings?scanId=${encodeURIComponent(activeScanId)}`, { cache: "no-store" });
        const payload = (await response.json()) as {
          visibility?: AiVisibilityStatus | null;
          recentScans?: AiVisibilityScanSummary[];
        };
        if (response.ok && payload.visibility && !cancelled) {
          setAiVisibility(payload.visibility);
          setVisibilityScans(payload.recentScans ?? []);
        }
      } catch {
        // Same independence as loadRedditMonitoring above: a transient
        // settings fetch failure must not disturb other loaded state.
      }
    }

    void loadRedditConnection();
    void loadRedditMonitoring();
    void loadAiVisibility();
    // Reddit OAuth status changes only in response to a user action taken
    // on this same page (connect/disconnect), so it does not need the same
    // repeating refetch -- only the two background-scheduled panels do.
    const backgroundStatusTimer = window.setInterval(() => {
      void loadRedditMonitoring();
      void loadAiVisibility();
    }, BACKGROUND_STATUS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(backgroundStatusTimer);
    };
  }, [view, accessLevel, scanResponse?.scan.id]);

  /** The body for POST /api/scans, matching whichever tab the user actually
   * submitted -- see LandingSubmission. The two are otherwise interchangeable
   * inputs to the same createScan/runScan pipeline (see scan-workflow.ts). */
  const scanCreateBody = useCallback(
    (extra: Record<string, unknown>): Record<string, unknown> =>
      inputMode === "context" ? { contextText, ...extra } : { websiteUrl: url, ...extra },
    [inputMode, url, contextText],
  );

  /**
   * Real production bug: the "scanning" phase effect below decides whether
   * to reuse the scan already created (and started) during the review step,
   * or to create a brand new one, by comparing the raw `url` the user typed
   * against `created.scan.websiteUrl`. But by the time review has run, the
   * website-crawl stage has already overwritten `scan.websiteUrl` with the
   * *canonical* crawled URL (protocol added, trailing slash, etc. -- see
   * `websiteUrl: websiteCrawl.canonicalUrl` in scan-workflow.ts). Those two
   * strings essentially never match unless the user happened to type the
   * exact canonical form, so the app treated nearly every scan as "input
   * changed" and created a second, fully independent scan for the same
   * business -- doubling every paid discovery/enrichment/AI call for one
   * user action. This strips protocol/trailing-slash/case before comparing
   * so cosmetic canonicalization differences no longer look like a real
   * input change, while a genuinely different domain still correctly does.
   */
  const normalizedWebsiteForComparison = useCallback(
    (value: string): string =>
      value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, ""),
    [],
  );

  function startScan(submission: LandingSubmission) {
    navigationVersionRef.current += 1;
    clearStableScanUrl();
    setScanConnected(true);
    if (submission.mode === "context") {
      setInputMode("context");
      setContextText(submission.contextText);
      setUrl("");
    } else {
      setInputMode("website");
      setUrl(submission.websiteUrl);
      setContextText("");
    }
    setMonitoring(null);
    setMonitorRuns(null);
    setAiVisibility(null);
    setVisibilityScans(null);
    resumedScanRef.current = null;
    analysisScanRef.current = null;
    partialScanIdRef.current = "";
    partialVersionRef.current = 0;
    partialHasVisibleResultsRef.current = false;
    setLivePartial(null);
    setLiveReplyEdits({});
    setScanResponse(null);
    setScanProgress([]);
    setErrorMessage("");
    setReviewScanId("");
    setView("analyzing");
  }

  // Analysis acceptance and status are separate from the reviewed Reddit run.
  useEffect(() => {
    if (view !== "analyzing") return;
    let cancelled = false;
    let polling: ReturnType<typeof startScanPolling> | undefined;
    const fail = (error: unknown) => {
      if (cancelled) return;
      setErrorMessage(error instanceof Error ? error.message : "Website analysis could not be opened.");
      setView("error");
    };
    (async () => {
      try {
        analysisScanRef.current ??= (async () => {
          const response = await fetch("/api/scans", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify(scanCreateBody({ reviewFirst: true })),
          });
          const payload = await readScanResponse<ApiScanResponse>(response);
          if (!payload.scan?.id) throw new Error("We could not create the scan.");
          return payload;
        })();
        const created = await analysisScanRef.current;
        if (cancelled) return;
        setScanResponse(created);
        setScanProgress(created.scan.progress);
        setAccessLevel(effectiveAccessLevel(created.access));
        setReviewScanId(created.scan.id);
        keepStableScanUrl(created.scan.id);
        let requestAnalysis = !created.scan.phase || created.scan.phase === "created";
        let acceptanceAttempted = false;
        polling = startScanPolling({
          onConnectionChange: setScanConnected,
          onError: fail,
          run: async signal => {
            let latest: ApiScanResponse;
            if (requestAnalysis) {
              requestAnalysis = false;
              acceptanceAttempted = true;
              latest = await readScanResponse<ApiScanResponse>(await fetch(
                `/api/scans/${encodeURIComponent(created.scan.id)}/analyze`, { method: "POST", signal },
              ));
            } else {
              latest = await readScanResponse<ApiScanResponse>(await fetch(
                `/api/scans/${encodeURIComponent(created.scan.id)}?statusOnly=1`, { cache: "no-store", signal },
              ));
            }
            signal.throwIfAborted();
            const merged = { ...created, scan: { ...created.scan, ...latest.scan }, access: latest.access };
            analysisScanRef.current = Promise.resolve(merged);
            setScanProgress(latest.scan.progress);
            setScanResponse(current => current ? { ...current, scan: { ...current.scan, ...latest.scan }, access: latest.access } : merged);
            if (latest.scan.status === "failed") throw new Error(latest.scan.error ?? "Website analysis failed.");
            if (latest.scan.phase === "created" && acceptanceAttempted) {
              throw new Error("Your scan was saved, but background work was not accepted. Reload this saved scan to retry acceptance.");
            }
            if (latest.scan.phase === "awaiting_review") {
              if (!latest.scan.analysisReady) throw new Error("This older scan has an incomplete profile. Start a new scan to review the full analysis.");
              setReviewScanId(created.scan.id);
              setView("competitors");
              return true;
            }
            return false;
          },
        });
      } catch (error) { fail(error); }
    })();
    return () => { cancelled = true; polling?.stop(); };
  }, [view, url, contextText, inputMode, scanCreateBody]);

  // Only the approval button can submit a Reddit run. Status/focus cannot.
  async function beginRedditScan(reviewVersion: string) {
    const response = await fetch(`/api/scans/${encodeURIComponent(reviewScanId)}/run`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewVersion }),
    });
    const accepted = await readScanResponse<ApiScanResponse>(response);
    resumedScanRef.current = accepted;
    setScanResponse(accepted);
    setScanProgress(accepted.scan.progress);
    setScanConnected(true);
    setView("scanning");
  }

  useEffect(() => {
    if (view !== "scanning") return;
    let cancelled = false;
    let polling: ReturnType<typeof startScanPolling> | undefined;
    const fail = (error: unknown) => {
      if (cancelled) return;
      setErrorMessage(error instanceof Error ? error.message : "The saved scan could not be opened.");
      setView("error");
    };
    async function loadPartialIfChanged(scanId: string, advertisedVersion: number, signal: AbortSignal) {
      if (advertisedVersion <= partialVersionRef.current) return partialHasVisibleResultsRef.current;
      const payload = await readScanResponse<ApiPartialResponse>(await fetch(
        `/api/scans/${encodeURIComponent(scanId)}/partial?afterVersion=${partialVersionRef.current}`,
        { cache: "no-store", signal },
      ));
      signal.throwIfAborted();
      if (payload.changed && payload.partial && payload.version > partialVersionRef.current) {
        partialVersionRef.current = payload.version;
        const hasVisibleResults = payload.partial.previews.length > 0
          || payload.partial.opportunities.length > 0
          || payload.partial.relevantConversations.length > 0
          || payload.partial.replies.length > 0;
        partialHasVisibleResultsRef.current = hasVisibleResults;
        setLivePartial(current => mergeLivePartialState(current, payload.partial!));
        setAccessLevel(effectiveAccessLevel(payload.access));
      } else {
        partialVersionRef.current = Math.max(partialVersionRef.current, payload.version);
      }
      return partialHasVisibleResultsRef.current;
    }
    async function begin() {
      try {
        let created = resumedScanRef.current;
        if (!created && reviewScanId) {
          created = await readScanResponse<ApiScanResponse>(await fetch(
            `/api/scans/${encodeURIComponent(reviewScanId)}`, { cache: "no-store" },
          ));
        }
        const matchesCurrentInput = created
          ? inputMode === "context"
            ? created.scan.inputMode === "context" && created.scan.contextText === contextText
            : normalizedWebsiteForComparison(created.scan.websiteUrl) === normalizedWebsiteForComparison(url)
          : false;
        if (!created || !matchesCurrentInput) throw new Error("The saved scan could not be restored. Return to setup to start a new scan.");
        if (cancelled) return;
        const accepted = created;
        if (partialScanIdRef.current !== accepted.scan.id) {
          partialScanIdRef.current = accepted.scan.id;
          partialVersionRef.current = 0;
          partialHasVisibleResultsRef.current = false;
          setLivePartial(null);
          setLiveReplyEdits({});
        }
        setScanResponse(accepted);
        setScanProgress(accepted.scan.progress);
        setAccessLevel(effectiveAccessLevel(accepted.access));
        if (accepted.scan.status === "complete" && accepted.report) {
          setView(accountRef.current ? "report" : "results");
          return;
        }
        polling = startScanPolling({
          onConnectionChange: setScanConnected,
          onError: fail,
          run: async signal => {
            const latest = await readScanResponse<ApiScanResponse>(await fetch(
              `/api/scans/${accepted.scan.id}?statusOnly=1`, { cache: "no-store", signal },
            ));
            signal.throwIfAborted();
            setScanProgress(latest.scan.progress);
            setScanResponse(current => current ? { ...current, scan: { ...current.scan, ...latest.scan }, access: latest.access } : latest);
            const hasPartial = await loadPartialIfChanged(
              accepted.scan.id,
              latest.scan.runtimeProgress?.partialResultsVersion ?? 0,
              signal,
            );
            if (latest.scan.status === "failed") {
              if (hasPartial) {
                setErrorMessage(latest.scan.error ?? "The scan stopped before completion.");
                return true;
              }
              throw new Error(latest.scan.error ?? "The scan stopped before completion.");
            }
            if (latest.scan.status === "complete") {
              const completed = await readScanResponse<ApiScanResponse>(await fetch(
                `/api/scans/${accepted.scan.id}`, { cache: "no-store", signal },
              ));
              signal.throwIfAborted();
              if (!completed.report) throw new TypeError("The completed report is not available yet; refreshing.");
              setScanResponse(completed);
              setScanProgress(completed.scan.progress);
              setAccessLevel(effectiveAccessLevel(completed.access));
              setView(accountRef.current ? "report" : "results");
              return true;
            }
            return false;
          },
        });
      } catch (error) { fail(error); }
    }
    void begin();
    return () => { cancelled = true; polling?.stop(); };
  }, [view, url, contextText, inputMode, reviewScanId, normalizedWebsiteForComparison]);

  async function refreshScan(scanId: string) {
    const response = await fetch(`/api/scans/${scanId}`, { cache: "no-store" });
    const latest = (await response.json()) as ApiScanResponse;
    if (!response.ok) throw new Error(latest.error?.message ?? "Could not refresh access.");
    setScanResponse(latest);
    setAccessLevel(effectiveAccessLevel(latest.access));
    keepStableScanUrl(latest.scan.id);
  }

  function returnToSetup() {
    navigationVersionRef.current += 1;
    clearStableScanUrl();
    setView("landing");
  }

  /**
   * "View results" on a completed daily-monitoring run -- loads that run's
   * own scan (see RedditMonitorRunRecord.scanId, created by
   * monitoringScan() in reddit-monitor-workflow.ts) into the same report
   * view already on screen, in place. Reuses refreshScan rather than a
   * separate fetch: a monitor run's scan is a normal, workspace-owned
   * ScanRecord like any other, so GET /api/scans/{scanId} already works
   * for it unmodified.
   */
  async function viewMonitorRun(scanId: string) {
    try {
      await refreshScan(scanId);
      setStatusMessage("Loaded this monitoring run's results.");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Could not load this run's results.");
    }
  }

  async function recordFunnelEvent(
    name:
      | "potential_customer_count_revealed"
      | "opportunity_preview_viewed"
      | "suggested_reply_viewed"
      | "locked_results_viewed"
      | "unlock_cta_clicked",
  ) {
    if (!scanResponse?.scan.id) return;
    try {
      await fetch("/api/analytics/funnel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scanId: scanResponse.scan.id, name }),
      });
    } catch {
      // Measurement must never interrupt the Market Scan or checkout flow.
    }
  }

  async function checkout(planId: "full-access-pass" | "core") {
    if (!scanResponse?.scan.id) {
      setStatusMessage("Run a successful website scan before choosing access.");
      return;
    }
    try {
      setStatusMessage("Starting secure checkout…");
      const response = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          plan: planId === "core" ? "core" : "pass",
          scanId: scanResponse.scan.id,
        }),
      });
      const payload = (await response.json()) as {
        checkout?: { id: string; url: string; providerMode: "test" | "live" | "mock" };
        error?: { message?: string };
      };
      if (!response.ok || !payload.checkout) {
        throw new Error(payload.error?.message ?? "Checkout is not available yet.");
      }
      if (payload.checkout.providerMode !== "mock") {
        window.location.assign(payload.checkout.url);
        return;
      }

      setStatusMessage("Confirming the signed test webhook…");
      const webhookResponse = await fetch("/api/stripe/demo-webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ checkoutId: payload.checkout.id }),
      });
      const webhookPayload = (await webhookResponse.json()) as {
        access?: { plan: AccessLevel; unlocked: boolean; verifiedByWebhook: boolean };
        error?: { message?: string };
      };
      if (
        !webhookResponse.ok ||
        !webhookPayload.access?.unlocked ||
        !webhookPayload.access.verifiedByWebhook
      ) {
        throw new Error(webhookPayload.error?.message ?? "The webhook did not verify access.");
      }
      await refreshScan(scanResponse.scan.id);
      setStatusMessage(
        webhookPayload.access.plan === "core"
          ? "Core is active from a verified test webhook."
          : "Your 7-day pass is active from a verified test webhook.",
      );
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Checkout could not start.");
    }
  }

  function connectReddit() {
    if (!scanResponse?.scan.id) {
      setStatusMessage("Run a successful website scan before connecting Reddit.");
      return;
    }
    if (!redditConnection.configured) {
      setStatusMessage("Reddit OAuth must be configured on the server first. Copy & open Reddit still works.");
      return;
    }
    if (!redditConnection.canConnect) {
      setStatusMessage("An active Full Access Pass or Core plan is required to connect Reddit.");
      return;
    }
    window.location.assign(
      `/api/reddit/connect?scanId=${encodeURIComponent(scanResponse.scan.id)}`,
    );
  }

  async function disconnectReddit() {
    try {
      const response = await fetch("/api/reddit/status", { method: "DELETE" });
      if (!response.ok) throw new Error("Reddit could not be disconnected.");
      setRedditConnection((current) => ({
        ...current,
        connected: false,
        username: null,
      }));
      setStatusMessage("Reddit disconnected. Stored Reddit tokens were removed.");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Reddit could not be disconnected.");
    }
  }

  async function updateBusinessSummary(summary: string): Promise<boolean> {
    if (!scanResponse?.scan.id) return false;
    try {
      const response = await fetch(
        `/api/scans/${encodeURIComponent(scanResponse.scan.id)}/business-profile`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ summary }),
        },
      );
      const payload = (await response.json()) as {
        profile?: { summary: string };
        error?: { message?: string };
      };
      if (!response.ok || !payload.profile) {
        throw new Error(payload.error?.message ?? "Your business summary could not be saved.");
      }
      const correctedSummary = payload.profile.summary;
      setScanResponse((current) =>
        current?.report
          ? { ...current, report: { ...current.report, profile: { ...current.report.profile, summary: correctedSummary } } }
          : current,
      );
      setStatusMessage("Business summary updated.");
      return true;
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Your business summary could not be saved.");
      return false;
    }
  }

  async function updateMonitoring(
    enabled: boolean,
    watchTerms: RedditMonitoringStatus["watchTerms"],
  ): Promise<boolean> {
    const scanId = scanResponse?.scan.id;
    if (!scanId) {
      setStatusMessage("Daily Reddit monitoring could not be updated.");
      return false;
    }
    try {
      const response = await fetch("/api/monitoring/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled, watchTerms, scanId }),
      });
      const payload = (await response.json()) as {
        monitoring?: RedditMonitoringStatus;
        recentRuns?: RedditMonitorRunSummary[];
        error?: { message?: string };
      };
      if (!response.ok || !payload.monitoring) {
        throw new Error(payload.error?.message ?? "Daily Reddit monitoring could not be updated.");
      }
      setMonitoring(payload.monitoring);
      setMonitorRuns(payload.recentRuns ?? []);
      setStatusMessage(enabled
        ? "Daily Reddit monitoring is on. All active terms will be checked together."
        : "Daily Reddit monitoring is off.");
      return true;
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Daily Reddit monitoring could not be updated.");
      return false;
    }
  }

  async function updateAiVisibility(enabled: boolean): Promise<boolean> {
    const scanId = scanResponse?.scan.id;
    if (!scanId) {
      setStatusMessage("AI visibility tracking could not be updated.");
      return false;
    }
    try {
      const response = await fetch("/api/ai-visibility/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled, scanId }),
      });
      const payload = (await response.json()) as {
        visibility?: AiVisibilityStatus;
        recentScans?: AiVisibilityScanSummary[];
        error?: { message?: string };
      };
      if (!response.ok || !payload.visibility) {
        throw new Error(payload.error?.message ?? "AI visibility tracking could not be updated.");
      }
      setAiVisibility(payload.visibility);
      setVisibilityScans(payload.recentScans ?? []);
      setStatusMessage(enabled
        ? "AI visibility tracking is on. ChatGPT, Gemini and Perplexity will be checked weekly."
        : "AI visibility tracking is off.");
      return true;
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "AI visibility tracking could not be updated.");
      return false;
    }
  }

  async function regenerateReply(opportunityId: string): Promise<string | null> {
    const opportunity = dashboardData?.opportunities.find((item) => item.id === opportunityId);
    if (!opportunity) return null;
    try {
      setStatusMessage("Generating a new source-grounded reply…");
      const response = await fetch(`/api/replies/${opportunity.reply.id}/regenerate`, {
        method: "POST",
      });
      const payload = (await response.json()) as {
        reply?: { content: string };
        error?: { message?: string };
      };
      if (!response.ok || !payload.reply?.content) {
        throw new Error(payload.error?.message ?? "The reply could not be regenerated.");
      }
      setStatusMessage("Reply regenerated from the conversation and verified website facts.");
      return payload.reply.content;
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "The reply could not be regenerated.");
      return null;
    }
  }

  async function createCandidateReply(
    _conversationId: string,
    externalId: string,
  ): Promise<string | null> {
    if (!scanResponse?.scan.id) return null;
    try {
      setStatusMessage("Drafting a reply from the conversation and verified website facts…");
      const response = await fetch(
        `/api/scans/${scanResponse.scan.id}/candidates/${encodeURIComponent(externalId)}/reply`,
        { method: "POST" },
      );
      const payload = (await response.json()) as {
        reply?: { content: string };
        error?: { message?: string };
      };
      if (!response.ok || !payload.reply?.content) {
        throw new Error(payload.error?.message ?? "The reply could not be created.");
      }
      setStatusMessage("Reply drafted from the conversation and verified website facts.");
      return payload.reply.content;
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "The reply could not be created.");
      return null;
    }
  }

  async function recordPublication(
    opportunityId: string,
    replyText: string,
  ): Promise<boolean> {
    const opportunity = dashboardData?.opportunities.find((item) => item.id === opportunityId);
    if (!opportunity || !scanResponse) return false;
    const canPostDirectly = Boolean(
      redditConnection.connected && opportunity.canReplyOnReddit,
    );
    if (!canPostDirectly) {
      if (!opportunity.permalink || opportunity.isMock) {
        setStatusMessage("This result has no verified live Reddit link, so it cannot be opened or posted.");
        return false;
      }
      const copyPromise = copyText(replyText);
      window.open(opportunity.permalink, "_blank", "noopener,noreferrer");
      try {
        const copied = await copyPromise;
        const editResponse = await fetch(`/api/replies/${opportunity.reply.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: replyText }),
        });
        setStatusMessage(
          copied
            ? "Reply copied and the exact Reddit conversation opened. Review once more before pasting it."
            : "Reddit opened, but your browser blocked automatic copying. Use the Copy button before pasting.",
        );
        if (!editResponse.ok) {
          setStatusMessage("Reddit opened and the reply was copied, but the edited draft could not be saved.");
        }
      } catch {
        setStatusMessage("Reddit opened. Use the Copy button if the reply is not already on your clipboard.");
      }
      return false;
    }
    try {
      const editResponse = await fetch(`/api/replies/${opportunity.reply.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: replyText }),
      });
      const editPayload = (await editResponse.json()) as { error?: { message?: string } };
      if (!editResponse.ok) {
        throw new Error(editPayload.error?.message ?? "The edited reply could not be saved.");
      }
      const response = await fetch(`/api/replies/${opportunity.reply.id}/post-to-reddit`, {
        method: "POST",
      });
      const payload = (await response.json()) as {
        publication?: { url?: string };
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(payload.error?.message ?? "The reply could not be posted to Reddit.");
      }
      await refreshScan(scanResponse.scan.id);
      setStatusMessage("Reply posted to Reddit and recorded with its source provenance.");
      return true;
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "The reply could not be posted to Reddit.");
      return false;
    }
  }

  async function recordResult(
    opportunityId: string,
    kind: "click" | "conversion",
  ): Promise<boolean> {
    const opportunity = dashboardData?.opportunities.find((item) => item.id === opportunityId);
    if (!opportunity || !scanResponse) return false;
    try {
      const response = await fetch("/api/conversions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scanId: scanResponse.scan.id,
          replyId: opportunity.reply.id,
          kind,
          label: kind === "click" ? "Tracked Reddit reply click" : "Reddit-assisted conversion",
        }),
      });
      if (!response.ok) throw new Error("Conversion tracking requires an active Core plan.");
      setStatusMessage(
        kind === "click"
          ? "Tracked click recorded for this workspace."
          : "Tracked conversion recorded for this workspace.",
      );
      return true;
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "The conversion could not be recorded.");
      return false;
    }
  }

  if (view === "landing") return <Landing onSubmit={startScan} account={account} onSignOut={signOutAccount} />;
  if (view === "analyzing") {
    return (
      <Scanning
        url={url}
        inputMode={inputMode}
        progress={scanProgress}
        stepIndex={1}
        stageIds={PRE_INPUT_STAGE_IDS}
        scan={scanResponse?.scan}
        connected={scanConnected}
      />
    );
  }
  if (view === "competitors") {
    return (
      <CompetitorsSetup
        scanId={reviewScanId}
        websiteUrl={url}
        onContinue={() => setView("profile")}
        onBack={returnToSetup}
      />
    );
  }
  if (view === "profile") {
    return (
      <DiscoveryProfile
        scanId={reviewScanId}
        websiteUrl={url}
        onStartScan={beginRedditScan}
        onBack={returnToSetup}
      />
    );
  }
  if (view === "restoring") {
    return <main className={styles.scanScreen}>
      <OnboardingHeader activeIndex={0} statusLabel="Opening saved scan" />
      <section className={styles.scanPanel}>
        <h1>Opening your saved scan</h1>
        <p role="status">{!scanConnected ? "Connection interrupted. Reconnecting to your saved scan automatically…" : statusMessage || "Checking its latest saved state. This does not start a new scan."}</p>
        <button className={styles.returnLink} type="button" onClick={returnToSetup}>Back to setup</button>
      </section>
    </main>;
  }
  if (view === "scanning") {
    return (
      <LiveScanDashboard
        url={url}
        inputMode={inputMode}
        progress={scanProgress}
        scan={scanResponse?.scan}
        connected={scanConnected}
        partial={livePartial ?? emptyLivePartialState()}
        replyEdits={liveReplyEdits}
        onReplyEdit={(replyId, value) => setLiveReplyEdits(current => ({ ...current, [replyId]: value }))}
        onRefreshOrder={() => setLivePartial(current => current ? refreshLiveResultOrder(current) : current)}
      />
    );
  }
  if (view === "results" && dashboardData) {
    return (
      <ResultsPreview
        data={dashboardData}
        domain={safeDomain(url)}
        inputMode={inputMode}
        onKeep={() => setView("signup")}
      />
    );
  }
  if (view === "signup" && dashboardData) {
    return (
      <SignupGate
        data={dashboardData}
        onSkip={() => setView("done")}
      />
    );
  }
  if (view === "done") {
    return (
      <DoneConfirmation
        signedIn={Boolean(account)}
        onGoToOpportunities={() => {
          setReportInitialSection("dashboard");
          setView("report");
        }}
        onSeePlans={() => {
          setReportInitialSection("billing");
          setView("report");
        }}
      />
    );
  }
  if (view === "error") {
    return (
      <main className={styles.scanScreen}>
        <OnboardingHeader activeIndex={0} statusLabel={scanResponse?.scan.status === "failed" ? "Market Scan stopped" : "Scan needs attention"} />
        <section className={`${styles.scanPanel} ${styles.errorPanel}`}>
          <div className={styles.errorMark}>!</div>
          <div className={styles.scanKicker}>Saved scan</div>
          <h1>{scanResponse?.scan.status === "failed" ? "The scan stopped before every check finished" : "We couldn’t open the scan right now"}</h1>
          <p>{errorMessage}</p>
          <button className={styles.tryAgain} type="button" onClick={returnToSetup}>Run another scan</button>
          {scanResponse?.scan.id && <button className={styles.returnLink} type="button" onClick={() => window.location.reload()}>Reopen this saved scan</button>}
          <div className={styles.domainSafety}>Completed stages remain recorded. Unverified findings are never promoted as definitive leads.</div>
        </section>
      </main>
    );
  }
  return (
    <div className={styles.reportFrame}>
      {statusMessage && (
        <button className={styles.statusToast} type="button" onClick={() => setStatusMessage("")}>
          <span>✓</span> {statusMessage} <b>×</b>
        </button>
      )}
      <ProductDashboard
        analyzedDomain={safeDomain(url)}
        scanResult={dashboardData ?? undefined}
        accessLevel={accessLevel}
        initialSection={reportInitialSection}
        onNewScan={() => {
          setReportInitialSection("dashboard");
          returnToSetup();
        }}
        onCheckout={checkout}
        onRegenerateReply={regenerateReply}
        onPublishOpportunity={recordPublication}
        onRecordClick={(opportunityId) => recordResult(opportunityId, "click")}
        onRecordConversion={(opportunityId) => recordResult(opportunityId, "conversion")}
        redditConnection={redditConnection}
        onConnectReddit={connectReddit}
        onDisconnectReddit={disconnectReddit}
        monitoring={monitoring}
        onUpdateMonitoring={updateMonitoring}
        onUpdateBusinessSummary={updateBusinessSummary}
        monitorRuns={monitorRuns}
        onViewMonitorRun={viewMonitorRun}
        aiVisibility={aiVisibility}
        onUpdateAiVisibility={updateAiVisibility}
        visibilityScans={visibilityScans}
        onCreateReply={createCandidateReply}
        onFunnelEvent={recordFunnelEvent}
      />
    </div>
  );
}
