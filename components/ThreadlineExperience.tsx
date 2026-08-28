"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ProductDashboard,
  type RedditConnectionStatus,
  type RedditMonitoringStatus,
  type RedditMonitorRunSummary,
  type AiVisibilityStatus,
  type AiVisibilityScanSummary,
} from "./demand-intelligence";
import {
  scanResponseToDashboard,
  type ApiScanResponse,
} from "./demand-intelligence/from-scan";
import { DiscoveryProfile } from "./DiscoveryProfile";
import { CompetitorsSetup } from "./CompetitorsSetup";
import styles from "./ThreadlineExperience.module.css";

// "competitors" is a dedicated, optional step (Back/Skip/Continue) between
// the fast analysis and the review screen. "refining" is a brief wait screen
// after it: the fast, homepage-only profile is never shown to the user --
// this waits for the fuller background analysis so "profile" always shows
// the complete picture. See RefiningProfile's doc comment.
type View =
  | "landing"
  | "analyzing"
  | "competitors"
  | "refining"
  | "profile"
  | "scanning"
  | "restoring"
  | "report"
  | "error";
type AccessLevel = "free" | "pass" | "core";

const SCAN_POLL_INTERVAL_MS = 3_000;
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
const SCAN_POLL_BACKOFF_BASE_MS = 1_500;
const SCAN_POLL_BACKOFF_MAX_MS = 10_000;

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

const progressSteps = [
  {
    label: "Understanding your business",
    detail: "Reading safe public pages on the submitted domain",
  },
  {
    label: "Mapping the problems you solve",
    detail: "Products, buyers, problems and source-backed proof",
  },
  {
    label: "Searching recent Reddit conversations",
    detail: "Only the current scan window",
  },
  {
    label: "Reading relevant posts and replies",
    detail: "Context, problem fit and source quality",
  },
  {
    label: "Identifying potential customers",
    detail: "Qualifying and deduplicating people by Reddit author",
  },
  {
    label: "Checking competitor frustrations",
    detail: "Verifying complaints and alternative-seeking signals",
  },
  {
    label: "Ranking the strongest opportunities",
    detail: "Ordering the best fits and preparing grounded replies",
  },
];

function safeDomain(value: string) {
  try {
    const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    return new URL(withProtocol).hostname.replace(/^www\./, "");
  } catch {
    return "your website";
  }
}

function isTransientPollFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!(error instanceof Error)) return false;
  return /networkerror|failed to fetch|fetch failed|load failed|network request failed/i.test(error.message);
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

function Brand() {
  return (
    <a className={styles.brand} aria-label="Threadline acceptance diagnostics" href="/acceptance-ai-diagnostics">
      <span className={styles.brandMark} aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>threadline</span>
    </a>
  );
}

export type LandingSubmission = { mode: "website"; websiteUrl: string } | { mode: "context"; contextText: string };

const MIN_CONTEXT_TEXT_LENGTH = 20;

const landingStats = [
  { value: "1,412", label: "Scans run since launch" },
  { value: "62k", label: "Conversations read and filtered" },
  { value: "2 min", label: "Average time to your first results" },
  { value: "94%", label: "Of what we read never reaches you" },
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
    q: "Do you post on my behalf?",
    a: "Only if you connect your Reddit account and press post. Without that, you copy the reply and we open the thread for you. Either way a human decides.",
  },
  {
    q: "How do you choose which subreddits to watch?",
    a: "From your site. We work out what you sell and who for, then look where those conversations actually happen — and you can add or remove communities and keywords whenever you like.",
  },
  {
    q: "Are these real conversations?",
    a: "Yes, and we label the source of every single one. If a result ever comes from a test fixture rather than live Reddit, it says so on the card. We would rather be boring about this than have you post into a thread that does not exist.",
  },
  {
    q: "What if my website does not explain much?",
    a: "Then correct us. After the crawl you get an editable profile of what we think you sell — fixing one line there is the single biggest improvement you can make to your results.",
  },
  {
    q: "Can I cancel?",
    a: "One click in billing, and the trial does not charge you if you leave before day seven.",
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
      <span className={styles.slLogoMark} aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className={styles.slLogoText}>Scooptr</span>
    </span>
  );
}

type LandingAccount = { id: string; email: string; name: string | null };

function Landing({ onSubmit }: { onSubmit: (submission: LandingSubmission) => void }) {
  // Website and "describe your market / idea" are two equal ways in, not a
  // primary path and a fallback -- see the two-tab requirement this
  // implements. Website stays the default tab.
  const [mode, setMode] = useState<"website" | "context">("website");
  const [url, setUrl] = useState("");
  const [contextText, setContextText] = useState("");
  const [error, setError] = useState("");
  const [openFaq, setOpenFaq] = useState(0);
  // undefined = still checking; null = signed out; object = signed in.
  // See /api/auth/session and the google-oauth.ts sign-in flow it reads.
  const [account, setAccount] = useState<LandingAccount | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/auth/session", { cache: "no-store" });
        const payload = (await response.json()) as { user: LandingAccount | null };
        if (!cancelled) setAccount(payload.user);
      } catch {
        if (!cancelled) setAccount(null);
      }
    })();
    // The Google sign-in callback redirects back here with ?account=... --
    // strip it once read rather than leaving it in the address bar. The
    // fetch above (not this param) is the source of truth for account
    // state; this is purely cosmetic URL cleanup.
    if (typeof window !== "undefined" && window.location.search.includes("account=")) {
      const url = new URL(window.location.href);
      url.searchParams.delete("account");
      window.history.replaceState(null, "", url.toString());
    }
    return () => {
      cancelled = true;
    };
  }, []);

  async function signOut() {
    setAccount(null);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Best-effort -- the client already reflects signed-out state either
      // way, and the session cookie is HttpOnly so there's nothing else to
      // clean up here even if the request failed.
    }
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
          <div className={styles.slNavLeft}>
            <LandingBrand />
            <div className={styles.slNavLinks}>
              <a href="#how-it-works">How it works</a>
              <a href="#compounding">Why Reddit</a>
              <a href="#example">Example</a>
              <a href="#pricing">Pricing</a>
            </div>
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
            <a href="#website-url" className={styles.slNavCta}>Run a free scan</a>
          </div>
        </div>
      </nav>

      <section className={styles.slHero} id="top">
        <div className={styles.slHeroInner}>
          <div className={styles.slHeroBadge}>
            <span>First scan is free &mdash; no card, no account</span>
            <span className={styles.slHeroBadgeArrow} aria-hidden="true">&#8594;</span>
          </div>

          <h1 className={styles.slHeroTitle}>
            Find the Reddit conversations where people are{" "}
            <span className={styles.slHeroTitleAccent}>already looking</span> for what you sell
          </h1>

          <p className={styles.slHeroLead}>
            Give us your website. We read it, work out what you actually sell, and bring back
            the threads where someone is asking for it right now &mdash; with a reply you&rsquo;d be
            happy to post.
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
                  aria-describedby={error ? "sl-url-error" : "sl-scan-note"}
                />
                <button type="submit" className={styles.slUrlSubmit}>
                  Run free scan <span aria-hidden="true">&#8594;</span>
                </button>
              </div>
            ) : (
              <div className={styles.slIdeaBox}>
                <textarea
                  id="market-context"
                  placeholder="A parental controls app for Android TV with daily time limits and no subscription."
                  value={contextText}
                  onChange={(event) => setContextText(event.target.value)}
                  aria-describedby={error ? "sl-url-error" : "sl-scan-note"}
                />
                <div className={styles.slIdeaFooter}>
                  <span className={styles.slIdeaNote}>No website needed &mdash; a couple of sentences is enough.</span>
                  <button type="submit" className={styles.slUrlSubmit}>
                    Run free scan <span aria-hidden="true">&#8594;</span>
                  </button>
                </div>
              </div>
            )}

            {error ? (
              <p className={styles.slFormError} id="sl-url-error">
                {error}
              </p>
            ) : (
              <p className={styles.slFormNote} id="sl-scan-note">
                {mode === "website"
                  ? "No card required · Public same-domain pages only · Usually several minutes"
                  : "No card required · No website needed · Usually several minutes"}
              </p>
            )}
          </form>

          <div className={styles.slAvatarRow}>
            <div className={styles.slAvatarStack}>
              <span className={styles.slAvatarDot} data-tone="a" />
              <span className={styles.slAvatarDot} data-tone="b" />
              <span className={styles.slAvatarDot} data-tone="a" />
              <span className={styles.slAvatarDot} data-tone="c" />
            </div>
            <span className={styles.slScanCount}>
              <strong>1,412</strong> scans run so far
            </span>
          </div>
        </div>

        <div className={styles.slPreviewWrap}>
          <span className={styles.slPreviewLabel}>[ your inbox, day one ]</span>
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
            <h2 className={styles.slSectionTitle}>Tell us what you sell. We do the reading. You write the reply.</h2>
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
              <h3>Reply in your own words</h3>
              <p>
                We draft something useful and grounded in your site. You edit it, or write your own. It
                only goes live when you say so.
              </p>
              <div className={styles.slHowDemo}>
                <div className={styles.slHowDemoReplyAuthor}>
                  <span className={styles.slAvatarDot} data-tone="a" />
                  u/you
                </div>
                <p className={styles.slHowDemoReplyText}>
                  We were on three tools for this and cut it down to one. The thing that mattered was
                  owning the keyword list ourselves
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
                <span className={styles.slCompoundIcon} data-tone="reddit" />
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
                <span className={styles.slCompoundIcon} data-tone="google" />
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
                <span className={styles.slCompoundIcon} data-tone="ai" />
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
              A thread is worth replying to for about a day. After that it&rsquo;s an archive. Scooptr
              watches your keywords, your brand and your competitors around the clock, so the ones worth
              answering are waiting for you in the morning rather than found three weeks late.
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
          The first scan takes about two minutes and costs nothing. No card, no account until you&rsquo;ve
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
}: {
  url: string;
  inputMode: "website" | "context";
  progress: ApiScanResponse["scan"]["progress"];
}) {
  const isContext = inputMode === "context";
  const domain = useMemo(() => safeDomain(url), [url]);
  const reported = new Map(progress.map((item) => [item.id, item]));
  const statuses = progressSteps.map((_, index) => {
    const stage = progress[index];
    return stage?.status ?? (index === 0 ? "active" : "pending");
  });

  return (
    <main className={styles.scanScreen}>
      <header className={styles.scanHeader}><Brand /><span>Building your Market Scan</span></header>
      <section className={styles.scanPanel}>
        <div className={styles.scanVisual} aria-hidden="true">
          <div className={styles.orbit}><i /><i /><i /></div>
          <span>↗</span>
        </div>
        <div className={styles.scanKicker}>{isContext ? "Analyzing your description" : `Analyzing ${domain}`}</div>
        <h1>{isContext ? "Turning your description into a demand map" : "Turning your website into a demand map"}</h1>
        <p>These stages update from the backend analysis pipeline.</p>
        <div className={styles.progressList}>
          {progressSteps.map((item, index) => (
            <div
              className={`${styles.progressItem} ${statuses[index] === "complete" ? styles.done : ""} ${statuses[index] === "active" ? styles.active : ""}`}
              key={item.label}
            >
              <span>{statuses[index] === "complete" ? "✓" : statuses[index] === "active" ? "•" : index + 1}</span>
              <div>
                <strong>{reported.get(progress[index]?.id ?? "")?.label ?? item.label}</strong>
                <small>{progress[index]?.detail ?? item.detail}</small>
              </div>
              {statuses[index] === "active" && <i />}
            </div>
          ))}
        </div>
        {!isContext && (
          <div className={styles.domainSafety}><span>⌁</span> Crawl boundary locked to <b>{domain}</b></div>
        )}
      </section>
    </main>
  );
}

/**
 * Waits for the background full business analysis (see scan-workflow.ts's
 * refineDiscoveryProfile) before showing the review screen, so the user
 * only ever sees the complete, multi-page profile -- never the thinner
 * fast-pass preview that made the earlier /analyze call return quickly.
 *
 * The competitors step the user just came from already gave that
 * background work a head start, so this is usually brief. Polling gives up
 * after ~90s and shows whatever is ready either way: the full analysis
 * still runs synchronously the moment the real scan starts regardless (see
 * scan-workflow.ts's canReusePersistedAnalysis check), so this screen only
 * ever affects how soon the user sees the better profile, never whether
 * discovery ends up using it.
 */
function RefiningProfile({
  scanId,
  url,
  inputMode,
  setView,
}: {
  scanId: string;
  url: string;
  inputMode: "website" | "context";
  setView: (view: View) => void;
}) {
  const isContext = inputMode === "context";
  const domain = useMemo(() => safeDomain(url), [url]);

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 56; // ~2.5s * 56 ~= 140s -- headroom for a 4-page
    // crawl plus a real analysisModel call under production latency, now that
    // refineDiscoveryProfile also retries once on a transient failure.

    const check = async () => {
      attempts += 1;
      try {
        const response = await fetch(
          `/api/scans/${encodeURIComponent(scanId)}/discovery-terms`,
          { cache: "no-store" },
        );
        if (response.ok && !cancelled) {
          const payload = (await response.json()) as { profileStage?: "fast" | "full" | null };
          if (!cancelled && payload.profileStage === "full") {
            clearInterval(timer);
            setView("profile");
            return;
          }
        }
      } catch {
        // Best-effort; a persistent failure just falls through to the
        // MAX_ATTEMPTS timeout below.
      }
      if (attempts >= MAX_ATTEMPTS && !cancelled) {
        clearInterval(timer);
        setView("profile");
      }
    };

    const timer = setInterval(check, 2_500);
    void check();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [scanId, setView]);

  return (
    <main className={styles.scanScreen}>
      <header className={styles.scanHeader}><Brand /><span>Finishing your analysis</span></header>
      <section className={styles.scanPanel}>
        <div className={styles.scanVisual} aria-hidden="true">
          <div className={styles.orbit}><i /><i /><i /></div>
          <span>↗</span>
        </div>
        <div className={styles.scanKicker}>{isContext ? "Analyzing your description" : `Analyzing ${domain}`}</div>
        <h1>Putting together your business profile</h1>
        <p>{isContext ? "Double-checking what we found in your description." : "Reading a few more pages and double-checking what we found."}</p>
        {!isContext && (
          <div className={styles.domainSafety}><span>⌁</span> Crawl boundary locked to <b>{domain}</b></div>
        )}
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
  const resumedScanRef = useRef<ApiScanResponse | null>(null);
  const [redditConnection, setRedditConnection] =
    useState<RedditConnectionStatus>(disconnectedReddit);
  const [monitoring, setMonitoring] = useState<RedditMonitoringStatus | null>(null);
  const [monitorRuns, setMonitorRuns] = useState<RedditMonitorRunSummary[] | null>(null);
  const [aiVisibility, setAiVisibility] = useState<AiVisibilityStatus | null>(null);
  const [visibilityScans, setVisibilityScans] = useState<AiVisibilityScanSummary[] | null>(null);
  const dashboardData = useMemo(
    () => (scanResponse ? scanResponseToDashboard(scanResponse) : null),
    [scanResponse],
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkoutState = params.get("checkout");
    const redditState = params.get("reddit");
    const scanId = params.get("scan_id");
    let cancelled = false;
    let pollTimer = 0;

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
      cleanUrl.searchParams.delete("scan_id");
      window.history.replaceState({}, "", `${cleanUrl.pathname}${cleanUrl.search}`);
    }

    if (!scanId || (checkoutState !== "success" && checkoutState !== "canceled")) {
      async function restoreLatestWorkspace() {
        try {
          const response = await fetch("/api/scans/latest", { cache: "no-store" });
          if (response.status === 401 || response.status === 404) return;
          const latest = (await response.json()) as ApiScanResponse;
          if (!response.ok || cancelled || !latest.scan?.id) return;
          setUrl(latest.scan.websiteUrl);
          setInputMode(latest.scan.inputMode ?? "website");
          setContextText(latest.scan.contextText ?? "");
          resumedScanRef.current = latest;
          setScanResponse(latest);
          setScanProgress(latest.scan.progress);
          setAccessLevel(effectiveAccessLevel(latest.access));
          if (latest.scan.status === "failed") {
            setErrorMessage(latest.scan.error ?? "The latest Market Scan failed.");
            setView("error");
          } else if (latest.scan.status === "complete" && latest.report) {
            setView("report");
          } else {
            setView("scanning");
          }
        } catch {
          // The acquisition page remains usable if a prior private workspace
          // cannot be restored; no claims or access are inferred client-side.
        }
      }
      void restoreLatestWorkspace();
      return () => {
        cancelled = true;
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
            throw new Error(latest.scan.error ?? "The scan stopped before completion.");
          }
          if (latest.scan.status === "complete" && latest.report) {
            setView("report");
          }

          if (checkoutState === "canceled") {
            setStatusMessage("Checkout canceled. Your free Market Scan is still available.");
            window.history.replaceState({}, "", window.location.pathname);
            return;
          }
          if (latest.access?.unlocked && latest.access.verifiedByWebhook) {
            setStatusMessage(
              latest.access.plan === "core"
                ? "Core is active from a verified Stripe webhook."
                : "Your 7-day pass is active from a verified Stripe webhook.",
            );
            window.history.replaceState({}, "", window.location.pathname);
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
    if (view !== "report") return;
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
        const response = await fetch("/api/monitoring/settings", { cache: "no-store" });
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
        const response = await fetch("/api/ai-visibility/settings", { cache: "no-store" });
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
  }, [view, accessLevel]);

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
    setScanResponse(null);
    setScanProgress([]);
    setErrorMessage("");
    setReviewScanId("");
    setView("analyzing");
  }

  // Phase one: create the scan without starting it, then analyze the website
  // (or the user's own description, in context mode) only. Reddit retrieval
  // waits until the user has reviewed the profile.
  useEffect(() => {
    if (view !== "analyzing") return;
    let cancelled = false;
    (async () => {
      try {
        const createdResponse = await fetch("/api/scans", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(scanCreateBody({ reviewFirst: true })),
        });
        const created = (await createdResponse.json()) as ApiScanResponse;
        if (!createdResponse.ok || !created.scan?.id) {
          throw new Error(created.error?.message ?? "We could not safely read that website.");
        }
        if (cancelled) return;
        setScanResponse(created);
        setScanProgress(created.scan.progress);
        setAccessLevel(effectiveAccessLevel(created.access));

        const analyzedResponse = await fetch(
          `/api/scans/${encodeURIComponent(created.scan.id)}/analyze`,
          { method: "POST" },
        );
        const analyzed = (await analyzedResponse.json()) as ApiScanResponse;
        if (!analyzedResponse.ok) {
          throw new Error(analyzed.error?.message ?? "We could not analyze that website.");
        }
        if (cancelled) return;
        setScanProgress(analyzed.scan.progress);
        setReviewScanId(created.scan.id);
        setView("competitors");
      } catch (analysisError) {
        if (cancelled) return;
        setErrorMessage(
          analysisError instanceof Error ? analysisError.message : "Website analysis failed.",
        );
        setView("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view, url, contextText, inputMode, scanCreateBody]);

  // Phase two: the user approved the profile, so start Reddit retrieval.
  async function beginRedditScan() {
    try {
      const response = await fetch(`/api/scans/${encodeURIComponent(reviewScanId)}/run`, {
        method: "POST",
      });
      if (!response.ok && response.status !== 202) {
        const failure = (await response.json()) as ApiScanResponse;
        throw new Error(failure.error?.message ?? "The scan could not be started.");
      }
      setView("scanning");
    } catch (startError) {
      setErrorMessage(startError instanceof Error ? startError.message : "The scan could not be started.");
      setView("error");
    }
  }

  useEffect(() => {
    if (view !== "scanning") return;
    let cancelled = false;
    let pollTimer = 0;

    async function begin() {
      try {
        let created = resumedScanRef.current;
        resumedScanRef.current = null;
        if (!created && reviewScanId) {
          // Already created and started by the review step; just poll it.
          const existing = await fetch(`/api/scans/${encodeURIComponent(reviewScanId)}`, {
            cache: "no-store",
          });
          const payload = (await existing.json()) as ApiScanResponse;
          if (existing.ok && payload.scan?.id) created = payload;
        }
        const matchesCurrentInput = created
          ? inputMode === "context"
            ? created.scan.inputMode === "context" && created.scan.contextText === contextText
            : normalizedWebsiteForComparison(created.scan.websiteUrl) === normalizedWebsiteForComparison(url)
          : false;
        if (!created || !matchesCurrentInput || created.scan.status === "failed") {
          const createdResponse = await fetch("/api/scans", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(scanCreateBody({ defer: true })),
          });
          created = (await createdResponse.json()) as ApiScanResponse;
          if (!createdResponse.ok || !created.scan?.id) {
            throw new Error(created.error?.message ?? "We could not safely read that website.");
          }
        }
        if (cancelled) return;
        setScanResponse(created);
        setScanProgress(created.scan.progress);
        setAccessLevel(effectiveAccessLevel(created.access));
        if (created.scan.status === "complete" && created.report) {
          setView("report");
          return;
        }

        let transientPollFailures = 0;
        while (!cancelled) {
          try {
            const response = await fetch(
              `/api/scans/${created.scan.id}?statusOnly=1`,
              { cache: "no-store" },
            );
            if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
              throw new TypeError(`Transient scan polling response (${response.status}).`);
            }
            const latest = (await response.json()) as ApiScanResponse;
            if (!response.ok) {
              throw new Error(latest.error?.message ?? "The scan could not be updated.");
            }
            setScanProgress(latest.scan.progress);

            if (latest.scan.status === "complete") {
              const reportResponse = await fetch(`/api/scans/${created.scan.id}`, { cache: "no-store" });
              if (
                reportResponse.status === 408 ||
                reportResponse.status === 425 ||
                reportResponse.status === 429 ||
                reportResponse.status >= 500
              ) {
                throw new TypeError(`Transient scan report response (${reportResponse.status}).`);
              }
              const completed = (await reportResponse.json()) as ApiScanResponse;
              if (!reportResponse.ok || !completed.report) {
                throw new Error(completed.error?.message ?? "The completed scan report could not be loaded.");
              }
              setScanResponse(completed);
              setScanProgress(completed.scan.progress);
              setAccessLevel(effectiveAccessLevel(completed.access));
              setView("report");
              return;
            }
            if (latest.scan.status === "failed") {
              throw new Error(latest.scan.error ?? "The scan stopped before completion.");
            }
            // "retrying" is not an error: a background job attempt failed but
            // another is already scheduled. Keep polling -- the active
            // stage's own `detail` text (already updated server-side) shows
            // the retry message, so no separate error state is needed here.
            transientPollFailures = 0;
          } catch (pollError) {
            if (!isTransientPollFailure(pollError)) throw pollError;
            transientPollFailures += 1;
            const retryDelay = Math.min(
              SCAN_POLL_BACKOFF_MAX_MS,
              SCAN_POLL_BACKOFF_BASE_MS * 2 ** Math.min(transientPollFailures - 1, 3),
            );
            await new Promise<void>((resolve) => {
              pollTimer = window.setTimeout(resolve, retryDelay);
            });
            continue;
          }

          await new Promise<void>((resolve) => {
            pollTimer = window.setTimeout(resolve, SCAN_POLL_INTERVAL_MS);
          });
        }
      } catch (error) {
        if (cancelled) return;
        window.clearTimeout(pollTimer);
        setErrorMessage(error instanceof Error ? error.message : "The scan stopped before completion.");
        setView("error");
      }
    }

    void begin();
    return () => {
      cancelled = true;
      window.clearTimeout(pollTimer);
    };
  }, [view, url, contextText, inputMode, reviewScanId, scanCreateBody, normalizedWebsiteForComparison]);

  async function refreshScan(scanId: string) {
    const response = await fetch(`/api/scans/${scanId}`, { cache: "no-store" });
    const latest = (await response.json()) as ApiScanResponse;
    if (!response.ok) throw new Error(latest.error?.message ?? "Could not refresh access.");
    setScanResponse(latest);
    setAccessLevel(effectiveAccessLevel(latest.access));
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

  async function updateMonitoring(
    enabled: boolean,
    watchTerms: RedditMonitoringStatus["watchTerms"],
  ): Promise<boolean> {
    try {
      const response = await fetch("/api/monitoring/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled, watchTerms }),
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
    try {
      const response = await fetch("/api/ai-visibility/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
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

  if (view === "landing") return <Landing onSubmit={startScan} />;
  if (view === "analyzing") {
    return <Scanning url={url} inputMode={inputMode} progress={scanProgress} />;
  }
  if (view === "competitors") {
    return (
      <CompetitorsSetup
        scanId={reviewScanId}
        websiteUrl={url}
        onContinue={() => setView("refining")}
        onBack={() => setView("landing")}
      />
    );
  }
  if (view === "refining") {
    return <RefiningProfile scanId={reviewScanId} url={url} inputMode={inputMode} setView={setView} />;
  }
  if (view === "profile") {
    return (
      <DiscoveryProfile
        scanId={reviewScanId}
        websiteUrl={url}
        onStartScan={beginRedditScan}
        onBack={() => setView("landing")}
      />
    );
  }
  if (view === "scanning" || view === "restoring") {
    return <Scanning url={url} inputMode={inputMode} progress={scanProgress} />;
  }
  if (view === "error") {
    return (
      <main className={styles.scanScreen}>
        <header className={styles.scanHeader}><Brand /><span>Market Scan paused</span></header>
        <section className={`${styles.scanPanel} ${styles.errorPanel}`}>
          <div className={styles.errorMark}>!</div>
          <div className={styles.scanKicker}>Safe analysis stopped</div>
          <h1>The scan stopped before every check finished</h1>
          <p>{errorMessage}</p>
          <button className={styles.tryAgain} type="button" onClick={() => setView("landing")}>Run another scan</button>
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
        onNewScan={() => setView("landing")}
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
