"use client";

import { useEffect, useMemo, useState } from "react";
import type { CompetitorProfileView } from "./CompetitorsSetup";
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
 * This screen is only ever reached after the upstream "refining" wait screen
 * (see ThreadlineExperience.tsx's RefiningProfile) has confirmed the full,
 * multi-page business analysis is ready -- the fast homepage-only preview
 * that made the initial /analyze call return quickly is never shown here.
 *
 * Competitor websites are a separate, earlier step (see CompetitorsSetup.tsx)
 * and are not edited on this screen.
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

export type DiscoveryProfileResponse = {
  analyzed: boolean;
  editable: boolean;
  profile: { name?: string; summary?: string; productCategory?: string } | null;
  derived: DiscoveryDerived | null;
  discoveryOverrides: Partial<DiscoveryDerived> | null;
  profileStage?: "fast" | "full" | null;
  /**
   * Competitor homepages analyzed on the earlier "Competitors & alternatives"
   * step (see CompetitorsSetup.tsx) -- already returned by this same GET
   * endpoint, just not previously read here. Used only to build the
   * read-only phrase subsection folded into the "Competitors & alternatives"
   * card below (see `competitorLanguage`): these phrases are edited on that
   * earlier step, not here, and already feed the actual Reddit search
   * regardless of whether this subsection has anything to show (see
   * competitorDiscoverySignals in scan-workflow.ts). A separate card for
   * this used to sit right next to the editable "Competitors & alternatives"
   * card and read as a duplicate of it, so it now lives inside that same
   * card instead of as a second one.
   */
  competitorProfiles?: CompetitorProfileView[];
};

/** Deduplicated (case-insensitive), in first-seen order, capped -- multiple competitors routinely share near-identical phrasing. */
function dedupedPhrases(values: string[], max: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
    if (result.length >= max) break;
  }
  return result;
}

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
    label: "Competitors & alternatives",
    hint: "Tools people compare you with or switch from.",
    max: 3,
  },
];

const MAX_TERMS: Record<EditableKey, number> = Object.fromEntries(
  EDITABLE_FIELDS.map(({ key, max }) => [key, max]),
) as Record<EditableKey, number>;

type EditableKey = (typeof EDITABLE_FIELDS)[number]["key"];

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
      onStartScan();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Something went wrong.");
      setSaving(false);
    }
  }

  const derived = data?.derived;

  const competitorLanguage = useMemo(() => {
    const ready = (data?.competitorProfiles ?? []).filter((profile) => profile.status === "ready");
    const keyphrases = dedupedPhrases(ready.flatMap((profile) => profile.keyphrases), 3);
    const painPhrases = dedupedPhrases(ready.flatMap((profile) => profile.painPhrases), 3);
    return { keyphrases, painPhrases, hasAny: keyphrases.length > 0 || painPhrases.length > 0 };
  }, [data?.competitorProfiles]);

  return (
    <main className={styles.screen}>
      <header className={styles.head}>
        <div>
          <div className={styles.kicker}>
            {websiteUrl ? `Analyzed ${websiteUrl.replace(/^https?:\/\//, "")}` : "Analyzed your description"}
          </div>
          <h1 className={styles.title}>What we&rsquo;ll look for</h1>
          <p className={styles.lead}>
            {data?.profile?.summary
              ? data.profile.summary
              : websiteUrl
                ? "This is what we understood from your website. You can adjust it, or scan straight away."
                : "This is what we understood from your description. You can adjust it, or scan straight away."}
          </p>
        </div>
      </header>

      {!data && !error && <p className={styles.loading}>Reading the discovery profile&hellip;</p>}

      {data?.profileStage === "fast" && (
        <p className={styles.hint}>
          Still refining a fuller pass over your site in the background &mdash; these are an early,
          quicker-model preview and may read a little rough. The scan itself always waits for the
          fuller analysis before searching Reddit, whether or not it finishes refining here first.
        </p>
      )}

      {derived && terms && (
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
                {key === "competitors" && competitorLanguage.hasAny && (
                  <div className={styles.subsection}>
                    <p className={styles.hint}>
                      From the competitor pages you analyzed on the previous step &mdash; already
                      included in your Reddit search.
                    </p>
                    {competitorLanguage.keyphrases.length > 0 && (
                      <>
                        <p className={styles.hint}>
                          What they sell ({competitorLanguage.keyphrases.length}/3)
                        </p>
                        <ul className={styles.chips}>
                          {competitorLanguage.keyphrases.map((phrase) => (
                            <li className={styles.chip} key={`keyphrase-${phrase}`}>
                              <span>{phrase}</span>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    {competitorLanguage.painPhrases.length > 0 && (
                      <>
                        <p className={styles.hint}>
                          Problems they speak to ({competitorLanguage.painPhrases.length}/3)
                        </p>
                        <ul className={styles.chips}>
                          {competitorLanguage.painPhrases.map((phrase) => (
                            <li className={styles.chip} key={`pain-${phrase}`}>
                              <span>{phrase}</span>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
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
