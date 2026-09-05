import type { BusinessUnderstanding, DeepQualification, QualifiedOpportunity } from "@/lib/domain/types";
import { contentFingerprint, isUsefulSearchPhrase } from "@/lib/intelligence/opportunity-ranking";
import { createOpenAiProviderFromEnv, openAiModelsFromEnv } from "@/lib/providers/openai.server";
import { aiCapacityFromEnv } from "@/lib/ai/capacity";
import { globallyBoundedAiRequestGate } from "@/lib/server/provider-capacity";
import type { OpportunityRecord, ReplyRecord, ScanBusinessProfile, UsageRecord } from "./contracts";
import { ApiError } from "./http";
import { getStateRepository } from "./repository";

function alternateDraft(
  profile: ScanBusinessProfile,
  opportunity: OpportunityRecord,
  generation: number,
): string {
  const verifiedFact = profile.features[generation % Math.max(profile.features.length, 1)] ?? profile.summary;
  const lead =
    generation % 2 === 0
      ? "I’d start by writing down the must-have outcome and testing a small real workflow in each option. Setup effort and the quality of the day-to-day process usually reveal more than a long feature list."
      : "The most useful comparison is the one based on your actual bottleneck: pick one recurring task, define what a good result looks like, and see which option gets there with the least ongoing maintenance.";
  // A context-mode business has no real site (profile.websiteUrl is ""),
  // so the reply must not claim one exists.
  const siteReference = profile.websiteUrl
    ? `Its public site describes ${verifiedFact}.`
    : `Here is what's relevant: ${verifiedFact}.`;
  return `${lead}\n\nFor transparency, I work with ${profile.name}. ${siteReference} If that is directly relevant to the workflow you mentioned, it may be worth a look alongside the other options—but I’d use the same test for all of them.`;
}

/** Safe for both a real website URL and the empty string a context-mode
 * business uses in place of one -- never throws. */
function hostnameOrEmpty(websiteUrl: string): string {
  if (!websiteUrl) return "";
  try {
    return new URL(websiteUrl).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function businessFromProfile(
  profile: ScanBusinessProfile,
  workspaceId: string,
): BusinessUnderstanding {
  const cited = <T,>(value: T) => ({ value, confidence: 0.8, provenanceIds: profile.sourceIds });
  const category = profile.productCategory ?? profile.features[0] ?? profile.name;
  return {
    businessId: `reply_business_${contentFingerprint(profile.websiteUrl || profile.name)}`,
    workspaceId,
    websiteUrl: profile.websiteUrl,
    canonicalDomain: hostnameOrEmpty(profile.websiteUrl),
    name: cited(profile.name),
    summary: cited(profile.summary),
    productCategory: cited(category),
    targetAudiences: cited(
      profile.targetAudience.map((name) => ({ name, description: name, pains: [] })),
    ),
    problemsSolved: cited(profile.problemsSolved),
    features: cited(profile.features.map((name) => ({ name, description: name, verified: true }))),
    competitors: cited(profile.competitors.map((name) => ({
      name,
      relationship: "unknown" as const,
      verification: "website_claim" as const,
    }))),
    irrelevantTopics: cited(profile.irrelevantTopics),
    productTerms: cited([profile.name, category, ...profile.features.slice(0, 3)].filter(isUsefulSearchPhrase)),
    brandTerms: cited(profile.brandTerms?.length ? profile.brandTerms : [profile.name]),
    customerProblemLanguage: cited(profile.problemsSolved),
    ambiguityRisks: cited(profile.ambiguityRisks ?? []),
    version: 2,
    generatedAt: new Date().toISOString(),
  };
}

function deepQualificationFromOpportunity(opportunity: OpportunityRecord): DeepQualification {
  return {
    externalId: opportunity.redditThingId ?? opportunity.sourceId,
    leadStatus: opportunity.leadStatus ?? "potential_customer",
    demandSignals: opportunity.demandSignals ?? [],
    intelligenceTags: opportunity.intelligenceTags ?? [],
    productFit: opportunity.productFit ?? "unknown",
    painSeverity: opportunity.painSeverity ?? "unknown",
    intent:
      opportunity.intent === "actively-looking"
        ? "actively_looking"
        : opportunity.potentialCustomerIntent === "competitor_switching"
          ? "switching"
          : opportunity.intent === "evaluating"
            ? "evaluating"
            : "problem_aware",
    timing: opportunity.timing ?? "unknown",
    evidenceQuality: opportunity.evidenceQuality ?? "unknown",
    replyability: opportunity.replyability ?? "unknown",
    communityRisk: opportunity.communityRisk,
    problemSummary: opportunity.customerProblem,
    competitorMentioned: opportunity.competitorSignal ?? undefined,
    whyItMatters: opportunity.whyItMatters,
    shouldReply: opportunity.shouldReply === true,
    autoReplyAllowed: opportunity.autoReplyAllowed === true,
    requiresHumanReview: opportunity.requiresHumanReview !== false,
    replyAngle: opportunity.replyAngle ?? undefined,
    mentionProduct: opportunity.mentionProduct === true,
    disclosureRequired: opportunity.disclosureRequired === true,
  };
}

function qualifiedOpportunity(
  opportunity: OpportunityRecord,
  business: BusinessUnderstanding,
): QualifiedOpportunity {
  const sourceMode = opportunity.sourceMode ?? (opportunity.synthetic ? "mock" : "live");
  const externalId = opportunity.redditThingId ?? opportunity.sourceId;
  const qualification = deepQualificationFromOpportunity(opportunity);
  return {
    id: opportunity.id,
    workspaceId: business.workspaceId,
    businessId: business.businessId,
    conversation: {
      provider: sourceMode === "apify-test" ? "apify-reddit-test" : sourceMode,
      sourceMode,
      externalId,
      kind: opportunity.conversationType,
      subreddit: opportunity.subreddit,
      title: opportunity.title,
      body: opportunity.excerpt,
      threadContext: opportunity.conversationContext,
      author: opportunity.author,
      permalink: opportunity.permalink || undefined,
      createdAt: opportunity.sourceCreatedAt,
      metrics: { score: 0, comments: opportunity.commentCount },
      discoveryLanes: opportunity.discoveryLanes,
      provenance: {
        id: opportunity.sourceId,
        kind: opportunity.synthetic ? "mock_reddit" : "reddit",
        provider: sourceMode === "apify-test" ? "apify-reddit-test" : sourceMode,
        providerExternalId: externalId,
        url: opportunity.permalink || undefined,
        title: opportunity.title,
        excerpt: opportunity.excerpt.slice(0, 280),
        contentHash: contentFingerprint(`${opportunity.title}\n${opportunity.excerpt}\n${opportunity.conversationContext ?? ""}`),
        observedAt: opportunity.postedAt,
        isMock: opportunity.synthetic,
      },
    },
    qualification,
    classification: {
      relevance: opportunity.productFit === "high" ? 1 : opportunity.productFit === "medium" ? 0.65 : 0.3,
      buyerIntent: opportunity.intent === "actively-looking" ? 1 : opportunity.intent === "evaluating" ? 0.75 : 0.5,
      customerProblem: opportunity.painSeverity === "high" ? 1 : opportunity.painSeverity === "medium" ? 0.65 : 0.4,
      competitorComplaint: opportunity.competitorComplaint ? 1 : 0,
      solutionFit: 0,
      recommendedAction: opportunity.shouldReply ? "reply_helpfully" : "monitor",
      communityRisk: opportunity.communityRisk,
      problemSummary: opportunity.customerProblem,
      competitorMentioned: opportunity.competitorSignal ?? undefined,
      rationale: [opportunity.whyItMatters],
    },
    rankScore: Math.max(0, Math.min(1, opportunity.score / 100)),
    status: "new",
    provenanceIds: [opportunity.sourceId],
    discoveredAt: opportunity.sourceCreatedAt,
  };
}

export function usageRecord(result: {
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  estimatedCostUsd: number;
}): UsageRecord {
  return {
    provider: "openai",
    purpose: "reply-generation",
    model: result.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    estimatedCostUsd: result.estimatedCostUsd,
  };
}

export async function regenerateReply(input: {
  reply: ReplyRecord;
  opportunity: OpportunityRecord;
  profile: ScanBusinessProfile;
}): Promise<ReplyRecord> {
  if (input.reply.status === "published") {
    throw new ApiError("Published replies cannot be regenerated.", 409, "reply_already_published");
  }
  if (input.opportunity.shouldReply !== true) {
    throw new ApiError(
      "This conversation is not currently suitable for a business reply.",
      409,
      "reply_not_recommended",
    );
  }

  const nextGeneration = input.reply.generation + 1;
  let content: string;
  let usage: UsageRecord | null = null;
  if (process.env.OPENAI_API_KEY?.trim()) {
    try {
      const business = businessFromProfile(input.profile, input.reply.workspaceId);
      const capacity = aiCapacityFromEnv();
      const provider = createOpenAiProviderFromEnv(process.env, { requestGate: globallyBoundedAiRequestGate({
        workspaceId: input.reply.workspaceId, localLimit: capacity.requestConcurrency,
        holderPrefix: `reply:${input.reply.id}`,
      }) });
      const generated = await provider.generateReply({
        business,
        opportunity: qualifiedOpportunity(input.opportunity, business),
        models: openAiModelsFromEnv(),
        instructions: input.opportunity.replyAngle ?? undefined,
      });
      content = generated.value.body.trim();
      usage = usageRecord(generated);
    } catch (error) {
      console.error("OpenAI reply regeneration failed", error);
      throw new ApiError(
        "The AI provider could not prepare a grounded reply. No generic reply was substituted.",
        502,
        "reply_generation_failed",
      );
    }
  } else if (input.opportunity.synthetic) {
    content = alternateDraft(input.profile, input.opportunity, nextGeneration);
  } else {
    throw new ApiError(
      "AI reply generation is unavailable for this real Reddit conversation.",
      503,
      "reply_generation_unavailable",
    );
  }

  if (!content.trim()) {
    throw new ApiError("The AI provider returned an empty reply.", 502, "reply_generation_failed");
  }
  const updated: ReplyRecord = {
    ...input.reply,
    content,
    generation: nextGeneration,
    updatedAt: new Date().toISOString(),
  };
  const repository = getStateRepository();
  await repository.saveReply(updated);
  if (usage) {
    const scan = await repository.getScan(updated.scanId);
    if (scan?.result) {
      scan.result.usage.push(usage);
      scan.updatedAt = new Date().toISOString();
      await repository.saveScan(scan);
    }
  }
  return updated;
}
