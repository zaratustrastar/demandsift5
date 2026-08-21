"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./DiscoveryProfile.module.css";

/**
 * "What we'll look for" — the review step between website analysis and Reddit
 * retrieval.
 *
 * Two rules shape this screen. Editing is optional: the default path is to read
 * what we understood and press "Scan Reddit", so nothing is required and no
 * field starts empty. And Boolean syntax is never shown — the user curates
 * plain terms, DemandSift compiles the searches.
 *
 * A second, optional tab lets the user analyze up to 3 competitor websites.
 * That is a sidecar to the business profile above, not a rewrite of it:
 * competitor-derived phrases are stored and shown completely separately
 * (see CompetitorProfileView below) and are never merged into `terms` or
 * `discoveryOverrides` -- the backend only folds them into Reddit query
 * planning, after the user's own product/pain/competitor terms, once the
 * scan actually starts (see scan-workflow.ts's competitorDiscoverySignals).
 */

export type DiscoveryDerived = {
  productTerms: string[];
  customerProblems: string[];
  competitors: string[];
  excludedTerms: string[];
  personas: string[];
  useCases: string[];
  purchaseTriggers: string[];
  alternatives: string[];
};

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

export type DiscoveryProfileResponse = {
  analyzed: boolean;
  editable: boolean;
  profile: { name?: string; summary?: string; productCategory?: string } | null;
  derived: DiscoveryDerived | null;
  discoveryOverrides: Partial<DiscoveryDerived> | null;
  /**
   * "fast" is a homepage-only preview shown while the full analysis keeps
   * running in the background; null/"full" both mean the complete
   * analysis. See the polling effect below, which upgrades an untouched
   * "fast" screen in place once refinement lands.
   */
  profileStage?: "fast" | "full" | null;
  /** Previously analyzed competitors, if any. Empty until the user adds some. */
  competitorProfiles?: CompetitorProfileView[];
};

/**
 * Only these reach the backend as overrides; the rest are read-only context.
 *
 * `max` mirrors the hard per-bucket caps redditQueryFamilies() enforces
 * server-side (3 product/category, 3 pain/problem, 3 competitor) -- capping
 * the add UI to the same numbers means every term a user adds here is one
 * that will actually be searched, rather than letting them stockpile terms
 * past the point where the backend silently stops using them.
 */
const EDITABLE_FIELDS = [
  {
    key: "productTerms" as const,
    label: "Product / category",
    hint: "What you sell, in the words people use.",
    max: 3,
  },
  {
    key: "customerProblems" as const,
    label: "Customer problems / pain language",
    hint: "How people describe the problem you solve.",
    max: 3,
  },
  {
    key: "competitors" as const,
    label: "Competitors / alternatives",
    hint: "Tools people compare you with or switch from.",
    max: 3,
  },
];

const MAX_TERMS: Record<EditableKey, number> = Object.fromEntries(
  EDITABLE_FIELDS.map(({ key, max }) => [key, max]),
) as Record<EditableKey, number>;

const CONTEXT_FIELDS = [
  { key: "personas" as const, label: "Who this is for" },
  { key: "useCases" as const, label: "Use cases" },
  { key: "purchaseTriggers" as const, label: "Purchase triggers" },
];

type EditableKey = (typeof EDITABLE_FIELDS)[number]["key"];

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

export function DiscoveryProfile({
  scanId,
  websiteUrl,
  onStartScan,
  onBack,
}: {
  scanId: string;
  websiteUrl: string;
  onStartScan: () => void;
  onBack: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"profile" | "competitors">("profile");
  const [data, setData] = useState<DiscoveryProfileResponse | null>(null);
  const [terms, setTerms] = useState<Record<EditableKey, string[]> | null>(null);
  // The capped starting point terms is compared against to decide whether
  // the user actually changed anything (see `edited` below). Capping the
  // AI's own output to each card's max is not itself an edit -- the crawl
  // routinely returns more candidates than the search caps ever use (e.g. 8
  // product terms when only 3 are ever searched), and treating that
  // pre-selection as a user override would misattribute an untouched
  // profile and, on every future load, silently re-show the same
  // (harmless but confusing) over-max count this baseline exists to fix.
  const [baselineTerms, setBaselineTerms] = useState<Record<EditableKey, string[]> | null>(null);
  const [additions, setAdditions] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const [competitorUrls, setCompetitorUrls] = useState<string[]>(
    Array.from({ length: MAX_COMPETITOR_URLS }, () => ""),
  );
  const [competitorProfiles, setCompetitorProfiles] = useState<CompetitorProfileView[]>([]);
  const [baselineCompetitorProfiles, setBaselineCompetitorProfiles] = useState<CompetitorProfileView[]>([]);
  const [competitorAdditions, setCompetitorAdditions] = useState<Record<string, string>>({});
  const [analyzingCompetitors, setAnalyzingCompetitors] = useState(false);
  const [competitorError, setCompetitorError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(
          `/api/scans/${encodeURIComponent(scanId)}/discovery-terms`,
          { cache: "no-store" },
        );
        const payload = (await response.json()) as DiscoveryProfileResponse;
        if (cancelled) return;
        if (!response.ok) throw new Error("We could not load the discovery profile.");
        setData(payload);
        const base = payload.derived;
        const overrides = payload.discoveryOverrides;
        // Show the best `max` candidates per card, not however many the
        // crawl happened to return -- the AI already returns its strongest
        // candidates first, and this is the same cap the backend enforces
        // when compiling searches, so trimming here is display-only, never
        // a change in what actually gets searched.
        const capped: Record<EditableKey, string[]> = {
          productTerms: (overrides?.productTerms ?? base?.productTerms ?? []).slice(0, MAX_TERMS.productTerms),
          customerProblems: (overrides?.customerProblems ?? base?.customerProblems ?? []).slice(0, MAX_TERMS.customerProblems),
          competitors: (overrides?.competitors ?? base?.competitors ?? []).slice(0, MAX_TERMS.competitors),
        };
        setTerms(capped);
        setBaselineTerms(capped);

        const existingCompetitors = payload.competitorProfiles ?? [];
        if (existingCompetitors.length > 0) {
          setCompetitorProfiles(existingCompetitors);
          setBaselineCompetitorProfiles(existingCompetitors);
          setCompetitorUrls(
            Array.from({ length: MAX_COMPETITOR_URLS }, (_, index) => existingCompetitors[index]?.url ?? ""),
          );
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Something went wrong.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scanId]);

  const edited = useMemo(() => {
    if (!baselineTerms || !terms) return false;
    return EDITABLE_FIELDS.some(
      ({ key }) => (terms[key] ?? []).join(" ") !== (baselineTerms[key] ?? []).join(" "),
    );
  }, [baselineTerms, terms]);

  const competitorPhrasesEdited = useMemo(() => {
    if (competitorProfiles.length !== baselineCompetitorProfiles.length) return false;
    const baselineByUrl = new Map(baselineCompetitorProfiles.map((profile) => [profile.url, profile]));
    return competitorProfiles.some((profile) => {
      const baseline = baselineByUrl.get(profile.url);
      if (!baseline) return false;
      return (
        profile.keyphrases.join(" ") !== baseline.keyphrases.join(" ") ||
        profile.painPhrases.join(" ") !== baseline.painPhrases.join(" ")
      );
    });
  }, [competitorProfiles, baselineCompetitorProfiles]);

  // Fast-pass profiles exist only to render this screen quickly; a fuller
  // analysis keeps running in the background. While the user hasn't touched
  // anything, poll for that upgrade and swap it in silently -- otherwise
  // pressing "Scan Reddit" unedited, or editing just one field, could
  // permanently save the fast pass's thinner terms as a user override (the
  // PUT below always sends all three fields together). Giving up after a
  // while, or if this never lands, is never a correctness problem: the full
  // analysis still runs synchronously when the real scan starts regardless
  // (see scan-workflow.ts's `canReusePersistedAnalysis` check) -- this only
  // affects whether the user sees the better terms a little sooner.
  useEffect(() => {
    if (data?.profileStage !== "fast" || edited) return;
    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 24; // ~2.5s * 24 ~= 60s
    const timer = setInterval(async () => {
      attempts += 1;
      if (attempts > MAX_ATTEMPTS) {
        clearInterval(timer);
        return;
      }
      try {
        const response = await fetch(
          `/api/scans/${encodeURIComponent(scanId)}/discovery-terms`,
          { cache: "no-store" },
        );
        if (!response.ok || cancelled) return;
        const payload = (await response.json()) as DiscoveryProfileResponse;
        if (cancelled || payload.profileStage !== "full") return;
        clearInterval(timer);
        setData(payload);
        const base = payload.derived;
        const capped: Record<EditableKey, string[]> = {
          productTerms: (base?.productTerms ?? []).slice(0, MAX_TERMS.productTerms),
          customerProblems: (base?.customerProblems ?? []).slice(0, MAX_TERMS.customerProblems),
          competitors: (base?.competitors ?? []).slice(0, MAX_TERMS.competitors),
        };
        setTerms(capped);
        setBaselineTerms(capped);
      } catch {
        // Best-effort; see the comment above this effect.
      }
    }, 2_500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [scanId, data?.profileStage, edited]);

  function removeTerm(key: EditableKey, term: string) {
    setTerms((current) =>
      current ? { ...current, [key]: current[key].filter((value) => value !== term) } : current,
    );
  }

  function addTerm(key: EditableKey) {
    const value = (additions[key] ?? "").trim();
    if (!value) return;
    setTerms((current) => {
      if (!current) return current;
      if (current[key].length >= MAX_TERMS[key]) return current;
      const exists = current[key].some(
        (term) => term.toLowerCase() === value.toLowerCase(),
      );
      return exists ? current : { ...current, [key]: [...current[key], value] };
    });
    setAdditions((current) => ({ ...current, [key]: "" }));
  }

  function updateCompetitorUrl(index: number, value: string) {
    setCompetitorUrls((current) => current.map((url, i) => (i === index ? value : url)));
  }

  async function analyzeCompetitors() {
    const urls = competitorUrls.map((url) => url.trim()).filter(Boolean);
    if (urls.length === 0) {
      setCompetitorError("Add at least one competitor website first.");
      return;
    }
    setAnalyzingCompetitors(true);
    setCompetitorError("");
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
      const analyzed = payload.competitorProfiles ?? [];
      setCompetitorProfiles(analyzed);
      setBaselineCompetitorProfiles(analyzed);
    } catch (analyzeError) {
      setCompetitorError(
        analyzeError instanceof Error ? analyzeError.message : "Something went wrong.",
      );
    } finally {
      setAnalyzingCompetitors(false);
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
    setCompetitorAdditions((current) => ({ ...current, [additionKey]: "" }));
  }

  async function startScan() {
    setSaving(true);
    setError("");
    try {
      // Only send overrides when something actually changed, so an untouched
      // profile stays attributed to the crawl rather than to the user.
      if (edited && terms) {
        const response = await fetch(
          `/api/scans/${encodeURIComponent(scanId)}/discovery-terms`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(terms),
          },
        );
        if (!response.ok) throw new Error("We could not save your changes.");
      }
      if (competitorPhrasesEdited) {
        const response = await fetch("/api/competitors", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scanId, competitorProfiles }),
        });
        if (!response.ok) throw new Error("We could not save your competitor edits.");
      }
      onStartScan();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Something went wrong.");
      setSaving(false);
    }
  }

  const derived = data?.derived;

  return (
    <main className={styles.screen}>
      <header className={styles.head}>
        <div>
          <div className={styles.kicker}>Analyzed {websiteUrl.replace(/^https?:\/\//, "")}</div>
          <h1 className={styles.title}>What we&rsquo;ll look for</h1>
          <p className={styles.lead}>
            {data?.profile?.summary
              ? data.profile.summary
              : "This is what we understood from your website. You can adjust it, or scan straight away."}
          </p>
        </div>
      </header>

      {!data && !error && <p className={styles.loading}>Reading the discovery profile&hellip;</p>}

      {data && (
        <div className={styles.tabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "profile"}
            className={activeTab === "profile" ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab("profile")}
          >
            Business profile
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "competitors"}
            className={activeTab === "competitors" ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab("competitors")}
          >
            Competitors{competitorProfiles.length > 0 ? ` (${competitorProfiles.length})` : ""}
          </button>
        </div>
      )}

      {activeTab === "profile" && derived && terms && (
        <>
          <section className={styles.grid}>
            {EDITABLE_FIELDS.map(({ key, label, hint, max }) => {
              const atMax = terms[key].length >= max;
              return (
                <div className={styles.card} key={key}>
                  <h2 className={styles.cardTitle}>{label}</h2>
                  <p className={styles.hint}>
                    {hint} ({terms[key].length}/{max})
                  </p>
                  <ul className={styles.chips}>
                    {terms[key].length === 0 && (
                      <li className={styles.empty}>Nothing here yet.</li>
                    )}
                    {terms[key].map((term) => (
                      <li className={styles.chip} key={term}>
                        <span>{term}</span>
                        <button
                          type="button"
                          aria-label={`Remove ${term}`}
                          onClick={() => removeTerm(key, term)}
                          disabled={!data.editable}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                  {data.editable && (
                    atMax ? (
                      <p className={styles.hint}>Max {max} reached &mdash; remove one to add another.</p>
                    ) : (
                      <div className={styles.addRow}>
                        <input
                          value={additions[key] ?? ""}
                          placeholder="Add a term"
                          onChange={(event) =>
                            setAdditions((current) => ({ ...current, [key]: event.target.value }))
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              addTerm(key);
                            }
                          }}
                        />
                        <button type="button" onClick={() => addTerm(key)}>
                          Add
                        </button>
                      </div>
                    )
                  )}
                </div>
              );
            })}
          </section>

          <section className={styles.context}>
            {CONTEXT_FIELDS.filter(({ key }) => (derived[key] ?? []).length > 0).map(
              ({ key, label }) => (
                <div key={key}>
                  <h3>{label}</h3>
                  <p>{derived[key].join(" · ")}</p>
                </div>
              ),
            )}
          </section>
        </>
      )}

      {activeTab === "competitors" && data && (
        <section className={styles.competitors}>
          <p className={styles.hint}>
            Optional. We&rsquo;ll watch Reddit for mentions of them alongside the keywords we
            generate from your own description. You can always add more later.
          </p>

          {data.editable && (
            <>
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
                  disabled={analyzingCompetitors}
                >
                  {analyzingCompetitors ? "Analyzing…" : "Analyze competitors"}
                </button>
              </div>
              {competitorError && <p className={styles.error}>{competitorError}</p>}
            </>
          )}

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
                                    disabled={!data.editable}
                                  >
                                    ×
                                  </button>
                                </li>
                              ))}
                            </ul>
                            {data.editable && !atMax && (
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
      )}

      {error && <p className={styles.error}>{error}</p>}

      <footer className={styles.actions}>
        <button className={styles.secondary} type="button" onClick={onBack} disabled={saving}>
          Use a different website
        </button>
        <button
          className={styles.primary}
          type="button"
          onClick={startScan}
          disabled={saving || !data?.analyzed}
        >
          {saving ? "Starting…" : "Scan Reddit"}
        </button>
      </footer>
      <p className={styles.note}>
        We search the last year of public Reddit activity and build the searches for you.
      </p>
    </main>
  );
}
