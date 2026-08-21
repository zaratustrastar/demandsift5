"use client";

import { useState } from "react";
import styles from "./DiscoveryProfile.module.css";

/**
 * "Who are your competitors?" -- a dedicated, optional step between
 * submitting a website and reviewing the business profile.
 *
 * This is a sidecar to the business-profile pipeline, not part of it: the
 * competitors analyzed here are stored completely separately
 * (CompetitorProfile, not BusinessUnderstanding) and only ever supplement
 * Reddit query planning after the fact -- see scan-workflow.ts's
 * competitorDiscoverySignals. Skipping this step, or entering nothing,
 * leaves scan behavior identical to not having this feature at all.
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
const MAX_COMPETITOR_PHRASES = 5;
type CompetitorPhraseField = "keyphrases" | "painPhrases";
const COMPETITOR_PHRASE_FIELDS: Array<{
  key: CompetitorPhraseField;
  label: string;
  hint: string;
}> = [
  { key: "keyphrases", label: "Keyphrases", hint: "What they sell, from their own homepage." },
  { key: "painPhrases", label: "Pain phrases", hint: "Problems their homepage speaks to." },
];

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
  const [phraseEdited, setPhraseEdited] = useState(false);
  const [competitorAdditions, setCompetitorAdditions] = useState<Record<string, string>>({});
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function updateCompetitorUrl(index: number, value: string) {
    setCompetitorUrls((current) => current.map((url, i) => (i === index ? value : url)));
  }

  async function analyzeCompetitors() {
    const urls = competitorUrls.map((url) => url.trim()).filter(Boolean);
    if (urls.length === 0) {
      setError("Add at least one competitor website first.");
      return;
    }
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
      setPhraseEdited(false);
    } catch (analyzeError) {
      setError(analyzeError instanceof Error ? analyzeError.message : "Something went wrong.");
    } finally {
      setAnalyzing(false);
    }
  }

  function removeCompetitorPhrase(url: string, field: CompetitorPhraseField, phrase: string) {
    setCompetitorProfiles((current) =>
      current.map((profile) =>
        profile.url === url
          ? { ...profile, [field]: profile[field].filter((value) => value !== phrase) }
          : profile,
      ),
    );
    setPhraseEdited(true);
  }

  function addCompetitorPhrase(url: string, field: CompetitorPhraseField) {
    const additionKey = `${url}|${field}`;
    const value = (competitorAdditions[additionKey] ?? "").trim();
    if (!value) return;
    setCompetitorProfiles((current) =>
      current.map((profile) => {
        if (profile.url !== url) return profile;
        if (profile[field].length >= MAX_COMPETITOR_PHRASES) return profile;
        const exists = profile[field].some((phrase) => phrase.toLowerCase() === value.toLowerCase());
        return exists ? profile : { ...profile, [field]: [...profile[field], value] };
      }),
    );
    setPhraseEdited(true);
    setCompetitorAdditions((current) => ({ ...current, [additionKey]: "" }));
  }

  async function saveAndContinue() {
    setSaving(true);
    setError("");
    try {
      if (phraseEdited && competitorProfiles.length > 0) {
        const response = await fetch("/api/competitors", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scanId, competitorProfiles }),
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
          <div className={styles.kicker}>Analyzed {websiteUrl.replace(/^https?:\/\//, "")}</div>
          <h1 className={styles.title}>Who are your competitors?</h1>
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
        <div className={styles.addRow}>
          <button
            type="button"
            className={styles.secondary}
            onClick={analyzeCompetitors}
            disabled={analyzing}
          >
            {analyzing ? "Analyzing…" : "Analyze competitors"}
          </button>
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
                  <>
                    {profile.summary && <p className={styles.hint}>{profile.summary}</p>}
                    {COMPETITOR_PHRASE_FIELDS.map(({ key, label, hint }) => {
                      const additionKey = `${profile.url}|${key}`;
                      const atMax = profile[key].length >= MAX_COMPETITOR_PHRASES;
                      return (
                        <div key={key}>
                          <p className={styles.hint}>
                            {label} &mdash; {hint} ({profile[key].length}/{MAX_COMPETITOR_PHRASES})
                          </p>
                          <ul className={styles.chips}>
                            {profile[key].length === 0 && (
                              <li className={styles.empty}>Nothing here yet.</li>
                            )}
                            {profile[key].map((phrase) => (
                              <li className={styles.chip} key={phrase}>
                                <span>{phrase}</span>
                                <button
                                  type="button"
                                  aria-label={`Remove ${phrase}`}
                                  onClick={() => removeCompetitorPhrase(profile.url, key, phrase)}
                                >
                                  ×
                                </button>
                              </li>
                            ))}
                          </ul>
                          {!atMax && (
                            <div className={styles.addRow}>
                              <input
                                value={competitorAdditions[additionKey] ?? ""}
                                placeholder="Add a phrase"
                                onChange={(event) =>
                                  setCompetitorAdditions((current) => ({
                                    ...current,
                                    [additionKey]: event.target.value,
                                  }))
                                }
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    event.preventDefault();
                                    addCompetitorPhrase(profile.url, key);
                                  }
                                }}
                              />
                              <button type="button" onClick={() => addCompetitorPhrase(profile.url, key)}>
                                Add
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <footer className={styles.actions}>
        <button className={styles.secondary} type="button" onClick={onBack} disabled={saving}>
          Back
        </button>
        <button className={styles.skipLink} type="button" onClick={onContinue} disabled={saving}>
          Skip
        </button>
        <button className={styles.primary} type="button" onClick={saveAndContinue} disabled={saving}>
          {saving ? "Continuing…" : "Continue"}
        </button>
      </footer>
    </main>
  );
}
