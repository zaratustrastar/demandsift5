"use client";

import { useEffect, useState } from "react";
import { OnboardingHeader } from "./OnboardingHeader";
import styles from "./DiscoveryProfile.module.css";

/**
 * "Who do people compare you with?" -- a dedicated, optional step between
 * submitting a website (or a freeform description) and reviewing the
 * business profile.
 *
 * This is a sidecar to the business-profile pipeline, not part of it: the
 * competitors analyzed here are stored completely separately
 * (CompetitorProfile, not BusinessUnderstanding). Their keyphrases/pain
 * phrases seed the editable "Competitors & alternatives" chip list on the
 * next screen (DiscoveryProfile.tsx), and that reviewed chip list -- not
 * this raw analysis -- is what scan-workflow.ts's reviewCompetitorTerms
 * actually searches.
 *
 * This screen pre-fills suggested competitors from GET
 * /api/scans/[scanId]/competitor-url-suggestions, which independently
 * verifies each proposed domain against its own homepage before ever
 * returning it (see lib/server/competitor-url-resolution.ts) -- a
 * suggested row's URL is only ever pre-filled when that verification
 * succeeded, never a raw guess. A name can still exist with no verified
 * URL (analysis found the competitor but resolution couldn't confirm a
 * domain, or found none at all); that row just shows the name with an
 * empty, editable URL field for the user to complete. DiscoveryProfile.tsx's
 * own chip list for these same names is unaffected; this is a different,
 * complementary use of it (prompting for a URL to crawl, not editing which
 * terms get searched).
 *
 * Skipping this step, or entering nothing, leaves scan behavior identical
 * to not having this feature at all: it continues with category/problem
 * queries only.
 */

export type CompetitorProfileView = {
  url: string;
  domain: string;
  name: string;
  summary: string;
  productCategory: string;
  keyphrases: string[];
  painPhrases: string[];
  status: "ready" | "failed";
  error?: string;
};

type CompetitorRow = {
  id: string;
  /** A name Scooptr's own website analysis already suggested -- shown as a
   * label alongside the URL field, which the user can edit, replace, or
   * clear either way. */
  suggestedName?: string;
  /** Pre-filled only when /api/scans/[scanId]/competitor-url-suggestions
   * independently verified a homepage actually identifies as this company
   * (see lib/server/competitor-url-resolution.ts) -- never a raw model
   * guess. Editable like any other value in this field; the user can
   * change or clear it freely. */
  url: string;
};

const MAX_COMPETITOR_URLS = 3;

let rowIdCounter = 0;
function nextRowId(): string {
  rowIdCounter += 1;
  return `competitor-row-${rowIdCounter}`;
}

function cleanDomain(value: string): string {
  return value.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
}

export function CompetitorsSetup({
  scanId,
  websiteUrl,
  onContinue,
  onBack,
}: {
  scanId: string;
  websiteUrl: string;
  onContinue: () => void;
  onBack: () => void;
}) {
  const [rows, setRows] = useState<CompetitorRow[]>([]);
  const [suggestionsLoaded, setSuggestionsLoaded] = useState(false);
  const [suggestionCount, setSuggestionCount] = useState(0);
  const [competitorProfiles, setCompetitorProfiles] = useState<CompetitorProfileView[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState("");
  // What analyzeCompetitors() last actually ran against, so Continue can
  // tell "URLs were typed but never analyzed" apart from "already analyzed,
  // just navigate" without a separate button for the user to remember to
  // press first.
  const [analyzedUrlsKey, setAnalyzedUrlsKey] = useState("");

  const isContextMode = !websiteUrl;

  // The names come from the same place discovery-terms' derived.competitors
  // does (business.competitors.value from the website/description
  // analysis), but this hits its own endpoint rather than discovery-terms
  // itself: that endpoint is also polled by DiscoveryProfile.tsx for
  // unrelated fields, and URL resolution/verification (model lookup +
  // homepage fetches) is real extra latency this screen wants but that one
  // never should pay. When there are no suggestions at all (analysis found
  // no named competitors), one empty row is seeded below so the screen
  // still shows an input to type into, rather than only a "+ Add a
  // competitor" link with nothing visible until it's clicked.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/scans/${encodeURIComponent(scanId)}/competitor-url-suggestions`, { cache: "no-store" });
        if (!response.ok) {
          if (!cancelled) setRows([{ id: nextRowId(), url: "" }]);
          return;
        }
        const payload = (await response.json()) as { suggestions?: Array<{ name: string; url: string | null }> };
        if (cancelled) return;
        const suggestions = (payload.suggestions ?? []).slice(0, MAX_COMPETITOR_URLS);
        setSuggestionCount(suggestions.length);
        setRows(
          suggestions.length > 0
            ? suggestions.map(({ name, url }) => ({ id: nextRowId(), suggestedName: name, url: url ? cleanDomain(url) : "" }))
            : [{ id: nextRowId(), url: "" }],
        );
      } catch {
        // Suggestions are a nice-to-have -- if the request itself fails,
        // still seed one empty row rather than leaving the screen with
        // only a "+ Add a competitor" link and nothing to type into.
        if (!cancelled) setRows([{ id: nextRowId(), url: "" }]);
      } finally {
        if (!cancelled) setSuggestionsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scanId]);

  function updateRowUrl(id: string, value: string) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, url: value } : row)));
  }

  function removeRow(id: string) {
    setRows((current) => current.filter((row) => row.id !== id));
  }

  function addRow() {
    setRows((current) => (current.length >= MAX_COMPETITOR_URLS ? current : [...current, { id: nextRowId(), url: "" }]));
  }

  // Returns the analyzed profiles (whatever their per-URL status), or null
  // if the request itself failed outright (network/API error) -- the caller
  // decides what a mix of ready/failed profiles means for navigation.
  async function analyzeCompetitors(urls: string[]): Promise<CompetitorProfileView[] | null> {
    setAnalyzing(true);
    setError("");
    try {
      const response = await fetch("/api/competitors/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scanId, urls }),
      });
      const payload = (await response.json()) as {
        competitorProfiles?: CompetitorProfileView[];
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(payload.error?.message ?? "We could not analyze those competitors.");
      }
      const profiles = payload.competitorProfiles ?? [];
      setCompetitorProfiles(profiles);
      setAnalyzedUrlsKey(urls.join("|"));
      return profiles;
    } catch (analyzeError) {
      setError(analyzeError instanceof Error ? analyzeError.message : "Something went wrong.");
      return null;
    } finally {
      setAnalyzing(false);
    }
  }

  const pendingUrls = rows.map((row) => row.url.trim()).filter(Boolean);
  const needsAnalysis = pendingUrls.length > 0 && pendingUrls.join("|") !== analyzedUrlsKey;

  // Analysis output (name, summary, keyphrases, ...) is context DemandSift
  // uses to build better Reddit searches, not something the user needs to
  // review -- so a single Continue press analyzes (if there's anything new
  // to analyze) and moves on by itself. The only time this stays on the
  // page is if a URL actually failed to analyze, so the user can see what
  // needs fixing instead of silently losing that competitor.
  async function saveAndContinue() {
    setError("");
    if (needsAnalysis) {
      const profiles = await analyzeCompetitors(pendingUrls);
      if (!profiles || profiles.some((profile) => profile.status === "failed")) return;
    }
    onContinue();
  }

  const hasSuggestions = rows.some((row) => row.suggestedName);

  return (
    <main className={`${styles.screen} ${styles.competitorsScreen}`}>
      <OnboardingHeader activeIndex={2} />
      <header className={styles.head}>
        <div>
          <div className={styles.kicker}>
            {isContextMode ? (
              <>Analyzed your description <span aria-hidden="true">✓</span></>
            ) : (
              <>Analyzed {cleanDomain(websiteUrl)} <span aria-hidden="true">✓</span></>
            )}
          </div>
          <h1 className={styles.title}>Who do people compare you with?</h1>
          <p className={styles.lead}>
            Add competitors or alternatives to help Scooptr find Reddit conversations where people
            are deciding between products like yours.
          </p>
        </div>
      </header>

      <section className={styles.competitors}>
        {suggestionsLoaded && (
          <>
            {rows.length > 0 && (
              <div className={styles.suggestedLabel}>
                {hasSuggestions ? "Suggested from your website" : "Add a competitor or alternative"}
                {hasSuggestions && suggestionCount > 0 && (
                  <span>{suggestionCount} competitor{suggestionCount === 1 ? "" : "s"} detected</span>
                )}
              </div>
            )}
            <div className={styles.urlList}>
              {rows.map((row) => (
                <div className={styles.urlRow} key={row.id}>
                  {row.suggestedName && <span className={styles.suggestedName}>{row.suggestedName}</span>}
                  <span className={styles.urlPrefix}>https://</span>
                  <input
                    value={row.url}
                    placeholder="competitor.com"
                    onChange={(event) => updateRowUrl(row.id, event.target.value)}
                  />
                  <button
                    type="button"
                    className={styles.removeRow}
                    onClick={() => removeRow(row.id)}
                    aria-label={`Remove ${row.suggestedName || "this competitor"}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            {rows.length < MAX_COMPETITOR_URLS && (
              <button type="button" className={styles.addRow} onClick={addRow}>
                + Add {rows.length > 0 ? "another" : "a"} competitor
              </button>
            )}
            <p className={styles.optionalNote}>Optional — you can edit these later.</p>
          </>
        )}
        {error && <p className={styles.error}>{error}</p>}

        {/*
         * A competitor's name/summary/keyphrases are analysis output for
         * DemandSift's own use (see the class doc above), not something the
         * user reviews -- so only URLs that actually failed to analyze
         * render here, as something the user needs to act on. A fully
         * successful analysis never reaches this render at all: Continue
         * moves on by itself.
         */}
        {competitorProfiles.some((profile) => profile.status === "failed") && (
          <div className={styles.competitorResults}>
            {competitorProfiles
              .filter((profile) => profile.status === "failed")
              .map((profile) => (
                <div className={styles.card} key={profile.url}>
                  <h2 className={styles.cardTitle}>{profile.name || profile.domain}</h2>
                  <p className={styles.hint}>
                    Could not analyze {profile.domain}
                    {profile.error ? `: ${profile.error}` : "."}
                  </p>
                </div>
              ))}
          </div>
        )}
      </section>

      <footer className={styles.actions}>
        <button className={styles.secondary} type="button" onClick={onBack} disabled={analyzing}>
          Back
        </button>
        <button className={styles.skipLink} type="button" onClick={onContinue}>
          Skip for now
        </button>
        <button className={styles.primary} type="button" onClick={saveAndContinue} disabled={analyzing}>
          {analyzing ? "Analyzing competitors…" : "Continue to search setup →"}
        </button>
      </footer>
    </main>
  );
}
