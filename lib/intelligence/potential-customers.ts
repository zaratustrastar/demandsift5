import type {
  OpportunityRecord,
  PotentialCustomerIntent,
  PotentialCustomerSummary,
} from "@/lib/server/contracts";

const DAY_MS = 86_400_000;

const INTENT_PRIORITY: Record<PotentialCustomerIntent, number> = {
  high_intent: 3,
  competitor_switching: 2,
  problem_aware: 1,
};

export function normalizedRedditAuthor(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/^u\//i, "").toLocaleLowerCase("en-US") ?? "";
  if (
    !normalized ||
    normalized === "reddit user" ||
    normalized === "[deleted]" ||
    normalized === "automoderator" ||
    normalized === "reddit" ||
    normalized.length > 100 ||
    /(?:^|[-_])(bot|moderator)(?:$|[-_])/i.test(normalized) ||
    normalized.endsWith("bot")
  ) {
    return null;
  }
  return normalized;
}

/** Legacy score-to-intent helper retained for stored/old fixtures only. */
export function potentialCustomerIntent(input: {
  buyerIntent: number;
  customerProblem: number;
  competitorComplaint: boolean;
}): PotentialCustomerIntent | null {
  if (input.buyerIntent >= 0.45) return "high_intent";
  if (input.competitorComplaint) return "competitor_switching";
  if (input.customerProblem >= 0.5) return "problem_aware";
  return null;
}

function validTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function previousFirstSeen(
  authorIdentifier: string,
  previous: readonly OpportunityRecord[],
): string | null {
  const timestamps = previous
    .filter(
      (row) => normalizedRedditAuthor(row.authorIdentifier ?? row.author) === authorIdentifier,
    )
    .map((row) => validTimestamp(row.firstSeenAt))
    .filter((value): value is number => value !== null);
  return timestamps.length > 0 ? new Date(Math.min(...timestamps)).toISOString() : null;
}

function isCategoricallyPotentialCustomer(row: OpportunityRecord): boolean {
  // New scans always set leadStatus. The fallback keeps old stored reports and
  // fixtures readable during migration without reintroducing score gating.
  return row.leadStatus === undefined
    ? Boolean(row.potentialCustomerIntent)
    : row.leadStatus === "potential_customer";
}

export function aggregatePotentialCustomers(input: {
  opportunities: readonly OpportunityRecord[];
  previousOpportunities?: readonly OpportunityRecord[];
  scanId: string;
  windowEndedAt: string;
  windowDays?: number;
}): { opportunities: OpportunityRecord[]; summary: PotentialCustomerSummary } {
  const windowDays = Math.max(1, Math.min(31, Math.trunc(input.windowDays ?? 7)));
  const windowEnd = validTimestamp(input.windowEndedAt) ?? Date.now();
  const windowStart = windowEnd - windowDays * DAY_MS;
  const previous = input.previousOpportunities ?? [];
  const groups = new Map<string, OpportunityRecord[]>();

  for (const row of input.opportunities) {
    const sourceCreatedAt = validTimestamp(row.sourceCreatedAt);
    const authorIdentifier = normalizedRedditAuthor(row.authorIdentifier ?? row.author);
    if (
      row.synthetic ||
      !authorIdentifier ||
      !row.permalink ||
      !row.sourceId ||
      !isCategoricallyPotentialCustomer(row) ||
      !row.potentialCustomerIntent ||
      row.communityRisk === "high" && row.shouldReply === true ||
      row.recommendedAction === "learn" ||
      sourceCreatedAt === null ||
      sourceCreatedAt < windowStart ||
      sourceCreatedAt > windowEnd + 5 * 60_000 ||
      /^\[(?:deleted|removed)\]$/i.test(row.excerpt.trim())
    ) {
      continue;
    }
    const normalized = { ...row, authorIdentifier };
    groups.set(authorIdentifier, [...(groups.get(authorIdentifier) ?? []), normalized]);
  }

  const opportunities = [...groups.entries()].map(([authorIdentifier, signals]) => {
    const ordered = [...signals].sort((left, right) => {
      const intentDifference =
        INTENT_PRIORITY[right.potentialCustomerIntent!] -
        INTENT_PRIORITY[left.potentialCustomerIntent!];
      return intentDifference || right.score - left.score;
    });
    const primary = ordered[0];
    const supportingSourceIds = [...new Set(ordered.flatMap((row) => [
      row.sourceId,
      ...row.supportingSourceIds,
    ]))];
    const priorFirstSeen = previousFirstSeen(authorIdentifier, previous);
    return {
      ...primary,
      scanId: input.scanId,
      authorIdentifier,
      firstSeenAt: priorFirstSeen ?? primary.firstSeenAt,
      supportingSourceIds,
      supportingSignalCount: supportingSourceIds.length,
      appearedInPreviousDemandDrop: Boolean(priorFirstSeen),
    };
  }).sort((left, right) => right.score - left.score);

  const breakdown = {
    highIntent: opportunities.filter((row) => row.potentialCustomerIntent === "high_intent").length,
    competitorSwitching: opportunities.filter(
      (row) => row.potentialCustomerIntent === "competitor_switching",
    ).length,
    problemAware: opportunities.filter(
      (row) => row.potentialCustomerIntent === "problem_aware",
    ).length,
  };
  const supportingSources = new Set(opportunities.flatMap((row) => row.supportingSourceIds));

  return {
    opportunities,
    summary: {
      total: opportunities.length,
      conversationCount: supportingSources.size,
      windowDays,
      windowStartedAt: new Date(windowStart).toISOString(),
      windowEndedAt: new Date(windowEnd).toISOString(),
      breakdown,
      newSincePreviousDemandDrop: opportunities.filter(
        (row) => !row.appearedInPreviousDemandDrop,
      ).length,
    },
  };
}
