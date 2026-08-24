"use client";

import { useEffect, useState } from "react";
import styles from "./DiscoveryProfile.module.css";

/**
 * "Competitors & alternatives" -- a dedicated, optional step between
 * submitting a website (or a freeform description) and reviewing the
 * business profile.
 *
 * The URL-analyze section below is a sidecar to the business-profile
 * pipeline, not part of it: the competitors analyzed there are stored
 * completely separately (CompetitorProfile, not BusinessUnderstanding) and
 * only ever supplement Reddit query planning after the fact -- see
 * scan-workflow.ts's competitorDiscoverySignals.
 *
 * The named-competitor chip section (context mode only) is different: it
 * edits BusinessUnderstanding.competitors directly, through the same
 * discovery-terms override endpoint DiscoveryProfile.tsx already uses, so a
 * competitor a context-mode user confirms here can actually drive a Reddit
 * search lane -- see discovery-overrides.ts and runScan's competitor query
 * lane in scan-workflow.ts.
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // What analyzeCompetitors() last actually ran against, so Continue can
  // tell "URLs were typed but never analyzed" apart from "already analyzed,
  // just navigate" without a separate button for the user to remember to
  // press first.
  const [analyzedUrlsKey, setAnalyzedUrlsKey] = useState("");

  // Context mode has no URL to crawl for the primary business, but the
  // business understanding built from the user's own description already
  // extracted competitors they explicitly named, and may have suggested a
  // few more it's reasonably confident about -- see analyzeBusinessFromContext
  // in openai.server.ts. This mirrors the phrase-chip pattern above, but
  // edits BusinessUnderstanding.competitors (via the discovery-terms
  // override endpoint) instead of a CompetitorProfile.
  const isContextMode = !websiteUrl;
  const [namedCompetitors, setNamedCompetitors] = useState<Array<{ name: string; source: "explicit" | "suggested" }>>([]);
  const [namedCompetitorsRemoved, setNamedCompetitorsRemoved] = useState<Set<string>>(new Set());
  const [namedCompetitorsAdded, setNamedCompetitorsAdded] = useState<string[]>([]);
  const [newCompetitorName, setNewCompetitorName] = useState("");
  const [namedCompetitorsEdited, setNamedCompetitorsEdited] = useState(false);

  useEffect(() => {
    if (!isContextMode || !scanId) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/scans/${encodeURIComponent(scanId)}/discovery-terms`, {
          cache: "no-store",
        });
        if (!response.ok || cancelled) return;
        const payload = (await response.json()) as {
          competitorSuggestions?: Array<{ name: string; source: "explicit" | "suggested" }>;
        };
        if (!cancelled) setNamedCompetitors(payload.competitorSuggestions ?? []);
      } catch {
        // Non-fatal: the chip list just starts empty, same as the empty state.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isContextMode, scanId]);

  const visibleNamedCompetitorNames = [
    ...namedCompetitors
      .map((competitor) => competitor.name)
      .filter((name) => !namedCompetitorsRemoved.has(name.toLocaleLowerCase("en-US"))),
    ...namedCompetitorsAdded,
  ];

  function removeNamedCompetitor(name: string) {
    setNamedCompetitorsRemoved((current) => new Set(current).add(name.toLocaleLowerCase("en-US")));
    setNamedCompetitorsAdded((current) => current.filter((existing) => existing !== name));
    setNamedCompetitorsEdited(true);
  }

  function addNamedCompetitor() {
    const value = newCompetitorName.trim();
    if (!value) return;
    const exists = visibleNamedCompetitorNames.some(
      (name) => name.toLocaleLowerCase("en-US") === value.toLocaleLowerCase("en-US"),
    );
    if (!exists) {
      setNamedCompetitorsAdded((current) => [...current, value]);
      setNamedCompetitorsEdited(true);
    }
    setNewCompetitorName("");
  }

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

  async function saveAndContinue() {
    setError("");
    const pendingUrls = competitorUrls.map((url) => url.trim()).filter(Boolean);
    if (pendingUrls.length > 0 && pendingUrls.join("|") !== analyzedUrlsKey) {
      // Typing competitor.com fields and pressing Continue is the same
      // action as the old separate "Analyze competitors" button used to be:
      // analyze first, show the results for review, then a second Continue
      // (URLs unchanged now) actually saves and moves on.
      await analyzeCompetitors(pendingUrls);
      return;
    }
    setSaving(true);
    try {
      if (isContextMode && namedCompetitorsEdited) {
        // Reuses the same override endpoint DiscoveryProfile.tsx's term
        // editor writes to -- a name kept from the AI-extracted list keeps
        // its original relationship/verification, so an explicitly-named
        // competitor stays query-eligible; only a brand-new hand-typed name
        // starts as an unverified hint, same as editing it there would.
        const response = await fetch(`/api/scans/${encodeURIComponent(scanId)}/discovery-terms`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ competitors: visibleNamedCompetitorNames }),
        });
        if (!response.ok) throw new Error("We could not save your competitor edits.");
      }
      onContinue();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Something went wrong.");
      setSaving(false);
    }
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
        {isContextMode && (
          <div className={styles.namedCompetitors}>
            <p className={styles.hint}>
              {namedCompetitors.length > 0
                ? "From your description \u2014 remove any that aren't right, or add your own."
                : "We didn't find a clear competitor in your description. Add any you'd like us to watch for, or skip."}
            </p>
            <ul className={styles.chips}>
              {visibleNamedCompetitorNames.length === 0 && (
                <li className={styles.empty}>No competitors added yet.</li>
              )}
              {visibleNamedCompetitorNames.map((name) => {
                const suggestion = namedCompetitors.find(
                  (competitor) => competitor.name.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"),
                );
                return (
                  <li className={styles.chip} key={name}>
                    <span>
                      {name}
                      {suggestion?.source === "suggested" ? " (suggested)" : ""}
                    </span>
                    <button type="button" aria-label={`Remove ${name}`} onClick={() => removeNamedCompetitor(name)}>
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className={styles.addRow}>
              <input
                value={newCompetitorName}
                placeholder="Add a competitor or alternative"
                onChange={(event) => setNewCompetitorName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addNamedCompetitor();
                  }
                }}
              />
              <button type="button" onClick={addNamedCompetitor}>
                Add
              </button>
            </div>
            <p className={styles.hint}>
              Know a competitor&rsquo;s website? Add it below for a deeper comparison.
            </p>
          </div>
        )}
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
                  // here anymore -- they now appear once, read-only, on the next
                  // screen's "Competitor language" card (see DiscoveryProfile.tsx),
                  // alongside the other discovery categories instead of duplicated
                  // on this one.
                  profile.summary && <p className={styles.hint}>{profile.summary}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <footer className={styles.actions}>
        <button className={styles.secondary} type="button" onClick={onBack} disabled={analyzing || saving}>
          Back
        </button>
        <button className={styles.skipLink} type="button" onClick={onContinue} disabled={saving}>
          Skip
        </button>
        <button className={styles.primary} type="button" onClick={saveAndContinue} disabled={analyzing || saving}>
          {analyzing ? "Analyzing competitors…" : saving ? "Continuing…" : "Continue"}
        </button>
      </footer>
    </main>
  );
}
