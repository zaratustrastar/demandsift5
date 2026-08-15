import type { BusinessUnderstanding, CitedValue } from "@/lib/domain/types";

/**
 * User edits to what DemandSift should look for.
 *
 * Users review the AI-derived discovery terms and can add, remove or replace
 * them. DemandSift stays responsible for compiling them into Reddit boolean
 * searches, so this layer only edits the *inputs* to query planning.
 *
 * The integrity rule that shapes this module: a term the user typed has no
 * website evidence behind it. It must never inherit the crawl's provenance ids,
 * because that would present a user's guess as a sourced finding. User terms
 * therefore carry no citations and are marked as user-provided, and anything
 * downstream that requires a source will correctly find none.
 */
export interface DiscoveryTermOverrides {
  productTerms?: string[];
  customerProblems?: string[];
  competitors?: string[];
  excludedTerms?: string[];
  updatedAt: string;
}

/** Per-field caps so an override cannot blow up query planning or cost. */
const MAX_TERMS_PER_FIELD = 25;
const MAX_TERM_LENGTH = 120;

export function sanitizeDiscoveryTerms(values: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  const cleaned = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter((value) => value.length > 0 && value.length <= MAX_TERM_LENGTH);
  // Case-insensitive de-duplication, keeping the user's own capitalisation.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of cleaned) {
    const key = value.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  return unique.slice(0, MAX_TERMS_PER_FIELD);
}

export function sanitizeDiscoveryOverrides(input: unknown): DiscoveryTermOverrides | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const overrides: DiscoveryTermOverrides = { updatedAt: new Date().toISOString() };
  let provided = false;

  for (const field of ["productTerms", "customerProblems", "competitors", "excludedTerms"] as const) {
    if (!(field in raw)) continue;
    // An explicitly supplied empty array is a deliberate clear, not a no-op.
    overrides[field] = sanitizeDiscoveryTerms(raw[field] as unknown[]);
    provided = true;
  }
  return provided ? overrides : null;
}

/**
 * Replace a cited field with the user's list. Confidence drops to "low" and
 * citations are dropped, because the evidence for these terms is the user's
 * judgement rather than the crawled site.
 */
function userProvided<T>(value: T): CitedValue<T> {
  return { value, confidence: "low", provenanceIds: [] };
}

export interface AppliedDiscoveryOverrides {
  business: BusinessUnderstanding;
  /** Fields the user actually changed, for diagnostics and UI display. */
  overriddenFields: string[];
}

/**
 * Apply user edits to the business understanding used for query planning.
 *
 * Only retrieval inputs are touched. The summary, features, audiences and other
 * sourced findings are left exactly as crawled, so editing search terms cannot
 * rewrite what DemandSift claims to have learned about the business.
 */
export function applyDiscoveryOverrides(
  business: BusinessUnderstanding,
  overrides: DiscoveryTermOverrides | null | undefined,
): AppliedDiscoveryOverrides {
  if (!overrides) return { business, overriddenFields: [] };

  const overriddenFields: string[] = [];
  const next: BusinessUnderstanding = { ...business };

  if (overrides.productTerms) {
    next.productTerms = userProvided(overrides.productTerms);
    overriddenFields.push("productTerms");
  }
  if (overrides.customerProblems) {
    next.customerProblemLanguage = userProvided(overrides.customerProblems);
    overriddenFields.push("customerProblems");
  }
  if (overrides.excludedTerms) {
    next.irrelevantTopics = userProvided(overrides.excludedTerms);
    overriddenFields.push("excludedTerms");
  }
  if (overrides.competitors) {
    // Competitor claims stay grounded: a user-named competitor is usable as a
    // search term, but it is not evidence and must not arrive pre-verified.
    next.competitors = userProvided(
      overrides.competitors.map((name) => {
        const existing = business.competitors.value.find(
          (competitor) =>
            competitor.name.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"),
        );
        return (
          existing ?? {
            name,
            relationship: "unknown" as const,
            // A user-typed competitor is a search hint, never a verified claim.
            verification: "unverified_hypothesis" as const,
          }
        );
      }),
    );
    overriddenFields.push("competitors");
  }

  return { business: next, overriddenFields };
}
