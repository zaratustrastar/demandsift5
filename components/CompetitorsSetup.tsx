"use client";

import { useState } from "react";
import styles from "./DiscoveryProfile.module.css";

/**
 * "Competitors & alternatives" -- a dedicated, optional step between
 * submitting a website (or a freeform description) and reviewing the
 * business profile.
 *
 * This is a sidecar to the business-profile pipeline, not part of it: the
 * competitors analyzed here are stored completely separately
 * (CompetitorProfile, not BusinessUnderstanding) and only ever supplement
 * Reddit query planning after the fact -- see scan-workflow.ts's
 * competitorDiscoverySignals.
 *
 * Named competitors the AI already extracted from a context-mode
 * description (BusinessUnderstanding.competitors) used to have their own
 * editable chip list here too, duplicating the "Competitors & alternatives"
 * card the very next screen (DiscoveryProfile.tsx) already shows for that
 * same data -- removed in favor of editing it once, there.
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

const MAX_COMPETITOR_URLS = 3;

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
  const [competitorUrls, setCompetitorUrls] = useState<string[]>(
    Array.from({ length: MAX_COMPETITOR_URLS }, () => ""),
  );
  const [competitorProfiles, setCompetitorProfiles] = useState<CompetitorProfileView[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState("");
  // What analyzeCompetitors() last actually ran against, so Continue can
  // tell "URLs were typed but never analyzed" apart from "already analyzed,
  // just navigate" without a separate button for the user to remember to
  // press first.
  const [analyzedUrlsKey, setAnalyzedUrlsKey] = useState("");

  // Still used for the header copy below ("Analyzed your description" vs.
  // the website), even though the named-competitor chip editor that used to
  // live here (context mode only) has moved to DiscoveryProfile.tsx's
  // "Competitors & alternatives" card, the very next screen.
  const isContextMode = !websiteUrl;

  function updateCompetitorUrl(index: number, value: string) {
    setCompetitorUrls((current) => current.map((url, i) => (i === index ? value : url)));
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

  const pendingUrls = competitorUrls.map((url) => url.trim()).filter(Boolean);
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

  return (
    <main className={styles.screen}>
      <header className={styles.head}>
        <div>
          <div className={styles.kicker}>
            {isContextMode ? "Analyzed your description" : `Analyzed ${websiteUrl.replace(/^https?:\/\//, "")}`}
          </div>
          <h1 className={styles.title}>Competitors & alternatives</h1>
          <p className={styles.lead}>
            Optional. We&rsquo;ll watch Reddit for mentions of them alongside the keywords we
            generate from your own description. You can always add more later.
          </p>
        </div>
      </header>

      <section className={styles.competitors}>
        <div className={styles.urlList}>
          {competitorUrls.map((url, index) => (
            <div className={styles.urlRow} key={index}>
              <span className={styles.urlPrefix}>https://</span>
              <input
                value={url}
                placeholder="competitor.com"
                onChange={(event) => updateCompetitorUrl(index, event.target.value)}
              />
            </div>
          ))}
        </div>
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
          Skip
        </button>
        <button className={styles.primary} type="button" onClick={saveAndContinue} disabled={analyzing}>
          {analyzing ? "Analyzing competitors…" : "Continue"}
        </button>
      </footer>
    </main>
  );
}
