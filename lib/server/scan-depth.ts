import type { EnrichedRedditConversation, RedditDiscoveryCandidate } from "../domain/types";

export class ScanDepthConfigurationError extends Error {
  readonly code = "scan_configuration_invalid";
}

function explicitBudget(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new ScanDepthConfigurationError(`${name} must be an integer from 1 to 20.`);
  }
  return parsed;
}

export function deepQualificationBudget(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const explicit = explicitBudget(env.REDDIT_DEEP_QUALIFICATION_BUDGET, "REDDIT_DEEP_QUALIFICATION_BUDGET");
  const legacy = explicitBudget(env.REDDIT_ENRICHMENT_BUDGET, "REDDIT_ENRICHMENT_BUDGET");
  if (explicit !== undefined && legacy !== undefined && explicit < legacy) {
    throw new ScanDepthConfigurationError("The deep qualification budget cannot silently reduce the existing explicit review budget.");
  }
  return explicit ?? legacy ?? 8;
}

export function validateThreadFetchConfiguration(env: Readonly<Record<string, string | undefined>>): void {
  if (!["harshmaur", "apify-harshmaur"].includes(env.REDDIT_PROVIDER?.trim().toLowerCase() ?? "")) return;
  const raw = env.APIFY_REDDIT_ENRICHMENT_LIMIT;
  if (raw === undefined || raw.trim() === "") return;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 20) {
    throw new ScanDepthConfigurationError("APIFY_REDDIT_ENRICHMENT_LIMIT must be an integer from 0 to 20 for Harshmaur; 0 disables thread fetching only.");
  }
}

/** Missing thread context must not remove a selected record from AI review. */
export function discoveryOnlyReview(candidate: RedditDiscoveryCandidate): EnrichedRedditConversation {
  const matched = { externalId: candidate.externalId, kind: candidate.kind, author: candidate.author,
    body: candidate.body, parentExternalId: candidate.parentExternalId, createdAt: candidate.createdAt };
  return { ...candidate, threadContext: undefined,
    provenance: { ...candidate.provenance, metadata: { ...candidate.provenance.metadata, enriched: false } },
    structuredContext: { originalPost: candidate.kind === "post" ? matched : undefined, matched,
      parentChain: [], replies: [], surroundingComments: [] },
  };
}
