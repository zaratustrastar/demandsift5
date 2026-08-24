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

  async function analyzeCompetitors(urls: string[]): Promise<boolean> {
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
      setCompetitorProfiles(payload.competitorProfiles ?? []);
      setAnalyzedUrlsKey(urls.join("|"));
      return true;
    } catch (analyzeError) {
      setError(analyzeError instanceof Error ? analyzeError.message : "Something went wrong.");
      return false;
    } finally {
      setAnalyzing(false);
    }
  }

  // Typing competitor.com fields and pressing Continue is the same action
  // as the old separate "Analyze competitors" button used to be: analyze
  // first, show the results for review, then a second press (URLs unchanged
  // now) actually saves and moves on. The button label below reflects which
  // of those two the next press will do, instead of always saying
  // "Continue" and silently doing something else on the first click.
  const pendingUrls = competitorUrls.map((url) => url.trim()).filter(Boolean);
  const needsAnalysis = pendingUrls.length > 0 && pendingUrls.join("|") !== analyzedUrlsKey;

  function saveAndContinue() {
    setError("");
    if (needsAnalysis) {
      void analyzeCompetitors(pendingUrls);
      return;
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
        {needsAnalysis && !analyzing && (
          <p className={styles.hint}>
            Press Continue to analyze {pendingUrls.length === 1 ? "this competitor" : "these competitors"}
            {" "}first &mdash; you&rsquo;ll see what we found, then press Continue again to move on.
          </p>
        )}
        {error && <p className={styles.error}>{error}</p>}

        {competitorProfiles.length > 0 && (
          <div className={styles.competitorResults}>
            {competitorProfiles.map((profile) => (
              <div className={styles.card} key={profile.url}>
                <h2 className={styles.cardTitle}>{profile.name || profile.domain}</h2>
                {profile.status === "failed" ? (
                  <p className={styles.hint}>
                    Could not analyze {profile.domain}
                    {profile.error ? `: ${profile.error}` : "."}
                  </p>
                ) : (
                  // Keyphrases/pain phrases are intentionally not shown or edited
                  // here anymore -- they now appear once, read-only, folded into
                  // the "Competitors & alternatives" card on the next screen (see
                  // DiscoveryProfile.tsx), instead of duplicated on this one.
                  profile.summary && <p className={styles.hint}>{profile.summary}</p>
                )}
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
          {analyzing ? "Analyzing competitors…" : needsAnalysis ? "Analyze competitors" : "Continue"}
        </button>
      </footer>
    </main>
  );
}
