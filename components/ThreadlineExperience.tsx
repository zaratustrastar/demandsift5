"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ProductDashboard,
  type RedditConnectionStatus,
  type RedditMonitoringStatus,
  type AiVisibilityStatus,
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

const sampleOpportunity = {
  community: "Source-linked community",
  time: "Provider record",
  title: "A qualified customer question appears here",
  excerpt:
    "The original public post or comment is shown only when it is returned by the configured provider.",
};

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

function Landing({ onSubmit }: { onSubmit: (submission: LandingSubmission) => void }) {
  // Website and "describe your market / idea" are two equal ways in, not a
  // primary path and a fallback -- see the two-tab requirement this
  // implements. Website stays the default tab.
  const [mode, setMode] = useState<"website" | "context">("website");
  const [url, setUrl] = useState("");
  const [contextText, setContextText] = useState("");
  const [error, setError] = useState("");

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
    <main className={styles.landing}>
      <div className={styles.ambientOne} />
      <div className={styles.ambientTwo} />
      <header className={styles.header}>
        <Brand />
        <nav className={styles.topNav} aria-label="Main navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#pricing">Pricing</a>
          <a className={styles.signIn} href="#website-url">
            Run a scan
          </a>
        </nav>
      </header>

      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <div className={styles.eyebrow}>
            <span className={styles.liveDot} />
            Demand intelligence for Reddit
          </div>
          <h1>
            Find the threads where your next customers are <em>already asking.</em>
          </h1>
          <p className={styles.heroLead}>
            We learn your business from its website -- or from your own description if
            it doesn&rsquo;t have one yet -- then surface the few public conversations worth
            joining, with thoughtful replies ready to refine.
          </p>

          <form className={styles.scanForm} onSubmit={submit} noValidate>
            <div className={styles.modeTabs} role="tablist" aria-label="How to start your scan">
              <button
                type="button"
                role="tab"
                aria-selected={mode === "website"}
                className={mode === "website" ? `${styles.modeTab} ${styles.modeTabActive}` : styles.modeTab}
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
                className={mode === "context" ? `${styles.modeTab} ${styles.modeTabActive}` : styles.modeTab}
                onClick={() => {
                  setMode("context");
                  setError("");
                }}
              >
                Describe your market / idea
              </button>
            </div>

            {mode === "website" ? (
              <>
                <label htmlFor="website-url">Your business website</label>
                <div className={styles.inputRow}>
                  <span className={styles.globe} aria-hidden="true">◎</span>
                  <input
                    id="website-url"
                    inputMode="url"
                    placeholder="yourcompany.com"
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    aria-describedby={error ? "url-error" : "scan-note"}
                  />
                  <button type="submit">
                    Run free scan <span aria-hidden="true">→</span>
                  </button>
                </div>
              </>
            ) : (
              <>
                <label htmlFor="market-context">What are you researching?</label>
                <div className={styles.textareaCard}>
                  <textarea
                    id="market-context"
                    placeholder="e.g. a scheduling tool for independent hairstylists who currently juggle texts and paper booking, competing loosely with Squarespace Appointments and plain old group chats"
                    value={contextText}
                    onChange={(event) => setContextText(event.target.value)}
                    aria-describedby={error ? "url-error" : "scan-note"}
                  />
                  <div className={styles.textareaActions}>
                    <button type="submit">
                      Run free scan <span aria-hidden="true">→</span>
                    </button>
                  </div>
                </div>
              </>
            )}
            {error ? (
              <p className={styles.formError} id="url-error">{error}</p>
            ) : (
              <p className={styles.formNote} id="scan-note">
                {mode === "website"
                  ? "No card required · Public same-domain pages only · Usually several minutes"
                  : "No card required · No website needed · Usually several minutes"}
              </p>
            )}
          </form>

          <div className={styles.safetyRow} aria-label="Product safeguards">
            <span><b>✓</b> Provider data clearly labeled</span>
            <span><b>✓</b> Evidence attached</span>
            <span><b>✓</b> Human-in-the-loop</span>
          </div>
        </div>

        <div className={styles.previewWrap} aria-label="Example opportunity preview">
          <div className={styles.previewHalo} />
          <div className={styles.previewWindow}>
            <div className={styles.previewTopbar}>
              <div className={styles.windowDots}><i /><i /><i /></div>
              <span>Opportunity feed</span>
            <span className={styles.mockBadge}>Interface preview</span>
            </div>
            <div className={styles.previewBody}>
              <div className={styles.foundRow}>
                <div>
                  <span className={styles.spark}>✦</span>
                  <div>
                    <strong>Qualified opportunity</strong>
                    <small>Matched to a verified customer problem</small>
                  </div>
                </div>
                <span className={styles.score}>Ranked fit</span>
              </div>
              <article className={styles.sampleCard}>
                <div className={styles.sampleMeta}>
                  <span className={styles.redditGlyph}>↗</span>
                  <strong>{sampleOpportunity.community}</strong>
                  <span>· {sampleOpportunity.time}</span>
                </div>
                <h2>{sampleOpportunity.title}</h2>
                <p>{sampleOpportunity.excerpt}</p>
                <div className={styles.signalTags}>
                  <span>Buyer intent</span>
                  <span>Problem match</span>
                  <span>Low risk</span>
                </div>
              </article>
              <div className={styles.replyCard}>
                <div className={styles.replyHead}>
                  <span><i /> Reply ready</span>
                  <span>Grounded in your website</span>
                </div>
                <p>
                  A complete, editable answer appears here only after the
                  conversation and relevant website facts are available.
                </p>
                <div className={styles.replyActions}>
                  <span>Edit</span><span>Regenerate</span><b>Review reply →</b>
                </div>
              </div>
            </div>
          </div>
          <div className={styles.floatNoteOne}>
            <span>↑</span><div><b>Demand signal</b><small>Only real stored matches</small></div>
          </div>
          <div className={styles.floatNoteTwo}>
            <span>✓</span><div><b>Source verified</b><small>From your website</small></div>
          </div>
        </div>
      </section>

      <section className={styles.how} id="how-it-works">
        <div className={styles.sectionIntro}>
          <span>From noise to next move</span>
          <h2>Three steps. Only useful signals.</h2>
        </div>
        <div className={styles.stepGrid}>
          <article>
            <span className={styles.stepNumber}>01</span>
            <h3>We learn your business</h3>
            <p>Public pages become a sourced profile of your product, buyers, problems and boundaries.</p>
          </article>
          <article>
            <span className={styles.stepNumber}>02</span>
            <h3>We qualify the conversation</h3>
            <p>Intent, problem fit, competitor gaps and community risk filter out the keyword noise.</p>
          </article>
          <article>
            <span className={styles.stepNumber}>03</span>
            <h3>You join usefully</h3>
            <p>Every opportunity includes an editable reply that answers first and never invents proof.</p>
          </article>
        </div>
      </section>

      <section className={styles.pricingStrip} id="pricing">
        <div>
          <span>Simple launch pricing</span>
          <h2>Scan free. Unlock only when the signal is real.</h2>
        </div>
        <div className={styles.priceItems}>
          <p><b>Free</b><span>Personalized Market Scan</span></p>
          <p><b>$12</b><span>7-day Full Access Pass</span></p>
          <p><b>$30/mo</b><span>Core continuous monitoring</span></p>
        </div>
        <small>Prices exclude VAT where applicable. Tax is calculated at checkout.</small>
      </section>
    </main>
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
  const [aiVisibility, setAiVisibility] = useState<AiVisibilityStatus | null>(null);
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
        };
        if (response.ok && payload.monitoring && !cancelled) {
          setMonitoring(payload.monitoring);
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
        };
        if (response.ok && payload.visibility && !cancelled) {
          setAiVisibility(payload.visibility);
        }
      } catch {
        // Same independence as loadRedditMonitoring above: a transient
        // settings fetch failure must not disturb other loaded state.
      }
    }

    void loadRedditConnection();
    void loadRedditMonitoring();
    void loadAiVisibility();
    return () => {
      cancelled = true;
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
    setAiVisibility(null);
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
            : created.scan.websiteUrl === url
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
  }, [view, url, contextText, inputMode, reviewScanId, scanCreateBody]);

  async function refreshScan(scanId: string) {
    const response = await fetch(`/api/scans/${scanId}`, { cache: "no-store" });
    const latest = (await response.json()) as ApiScanResponse;
    if (!response.ok) throw new Error(latest.error?.message ?? "Could not refresh access.");
    setScanResponse(latest);
    setAccessLevel(effectiveAccessLevel(latest.access));
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
        error?: { message?: string };
      };
      if (!response.ok || !payload.monitoring) {
        throw new Error(payload.error?.message ?? "Daily Reddit monitoring could not be updated.");
      }
      setMonitoring(payload.monitoring);
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
        error?: { message?: string };
      };
      if (!response.ok || !payload.visibility) {
        throw new Error(payload.error?.message ?? "AI visibility tracking could not be updated.");
      }
      setAiVisibility(payload.visibility);
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
        aiVisibility={aiVisibility}
        onUpdateAiVisibility={updateAiVisibility}
        onFunnelEvent={recordFunnelEvent}
      />
    </div>
  );
}
