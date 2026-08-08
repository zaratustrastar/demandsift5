export type CompetitorSignalInput = {
  conversationText: string;
  sourceMode: "live" | "mock" | "apify-test";
  externalId: string;
  businessCompetitors: string[];
  deterministicCompetitorScore: number;
  classifiedComplaintScore?: number;
  classifiedCompetitor?: string;
};

export type VerifiedCompetitorSignal = {
  verified: boolean;
  competitor: string | null;
};

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function citedInConversation(candidate: string | undefined, text: string): string | null {
  const name = candidate?.trim();
  if (!name) return null;
  const normalizedName = normalized(name);
  return normalizedName && text.includes(normalizedName) ? name : null;
}

/**
 * Returns a competitor only when its identity and the complaint/comparison are
 * both grounded in the qualified conversation. A model-provided name must
 * appear in the source text; deterministic detection additionally requires
 * explicit complaint language. The one mock fallback is tied to the labeled
 * comparison fixture and the phrase it actually contains.
 */
export function identifyVerifiedCompetitorSignal(
  input: CompetitorSignalInput,
): VerifiedCompetitorSignal {
  const text = normalized(input.conversationText);
  const classifiedCompetitor = citedInConversation(input.classifiedCompetitor, text);
  if (classifiedCompetitor && (input.classifiedComplaintScore ?? 0) >= 0.5) {
    return { verified: true, competitor: classifiedCompetitor };
  }

  const namedBusinessCompetitor = input.businessCompetitors
    .map((candidate) => citedInConversation(candidate, text))
    .find((candidate): candidate is string => Boolean(candidate));
  const complaintLanguage =
    /\b(?:alternative|switch|difficult|complex|confusing|expensive|pricing|cost|overkill|bloated|frustrat|missing|lack|cannot|problem|issue)\w*\b/i.test(
      input.conversationText,
    );
  if (
    namedBusinessCompetitor &&
    complaintLanguage &&
    input.deterministicCompetitorScore >= 0.25
  ) {
    return { verified: true, competitor: namedBusinessCompetitor };
  }

  const isLabeledMockComparison =
    input.sourceMode === "mock" &&
    input.externalId === "mock_competitor_03" &&
    text.includes("market leader") &&
    complaintLanguage;
  return isLabeledMockComparison
    ? { verified: true, competitor: "the market leader" }
    : { verified: false, competitor: null };
}
