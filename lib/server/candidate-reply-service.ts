import {
  competitorScore,
  legacyClassificationFromDeep,
  replyScore,
  researchScore,
} from "@/lib/intelligence/reddit-pipeline";
import type { QualifiedOpportunity } from "@/lib/domain/types";
import { createOpenAiProviderFromEnv, openAiModelsFromEnv } from "@/lib/providers/openai.server";
import type {
  MarketIntelligenceRecord,
  Provenance,
  ReplyRecord,
  ScanRecord,
} from "./contracts";
import { entitlementCoversWebsite } from "./business-access";
import { ApiError } from "./http";
import { createId } from "./ids";
import { getEffectiveEntitlement, getStateRepository } from "./repository";
import { businessFromProfile, usageRecord } from "./reply-service";

/**
 * On-demand reply generation for the unified carousel's "Create reply"
 * button -- the counterpart to reply-service.ts's regenerateReply, which
 * only ever rerolls a reply that already exists. This creates the first
 * one, for any Reddit candidate the scan already deep-qualified, whether it
 * is a published lead (which already always has a reply -- this path is
 * never used for those), an existing relevant conversation that was not
 * picked for an automatic scan-time draft, or a raw candidate that never
 * became a MarketIntelligenceRecord at all.
 *
 * Deliberately does NOT run deep qualification on demand: that is a
 * meaningful AI review with real safety consequences (community risk,
 * shouldReply, disclosure requirements) that the scan already ran for every
 * candidate it had budget for. A candidate the scan never got to reviewing
 * in depth is not silently upgraded into one here -- it is reported back to
 * the caller so the UI can say so, honestly, the same way the rest of this
 * product refuses to convert "not yet reviewed" into "reviewed and fine."
 */
export async function createCandidateReply(input: {
  workspaceId: string;
  scanId: string;
  externalId: string;
}): Promise<{ marketIntelligence: MarketIntelligenceRecord; reply: ReplyRecord }> {
  const repository = getStateRepository();
  const scan = await repository.getScan(input.scanId);
  if (!scan || scan.workspaceId !== input.workspaceId) {
    throw new ApiError("Scan was not found.", 404, "scan_not_found");
  }
  if (!scan.result) {
    throw new ApiError("Scan result is unavailable.", 409, "scan_result_unavailable");
  }

  const entitlement = await getEffectiveEntitlement(input.workspaceId);
  if (!entitlementCoversWebsite(entitlement, scan.websiteUrl)) {
    throw new ApiError(
      "Generating a new reply is included with the Full Access Pass or Core plan.",
      402,
      "upgrade_required",
    );
  }

  const state = scan.result.processedRedditState.find((row) => row.externalId === input.externalId);
  if (!state) {
    throw new ApiError("This Reddit post was not found in the scan.", 404, "candidate_not_found");
  }
  const qualification = state.deepQualification;
  if (!qualification) {
    throw new ApiError(
      "This post has not been reviewed by AI in enough depth yet to draft a reply.",
      409,
      "candidate_not_deep_qualified",
    );
  }
  if (qualification.shouldReply !== true) {
    throw new ApiError(
      "This conversation is not currently suitable for a business reply.",
      409,
      "reply_not_recommended",
    );
  }

  const existing = scan.result.marketIntelligence.find((row) => row.externalId === input.externalId);
  if (existing?.replyId) {
    const reply = await repository.getReply(existing.replyId);
    if (reply?.content.trim()) return { marketIntelligence: existing, reply };
  }

  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new ApiError(
      "AI reply generation is unavailable for this real Reddit conversation.",
      503,
      "reply_generation_unavailable",
    );
  }

  const business = businessFromProfile(scan.result.profile, input.workspaceId);
  const sourceId = existing?.sourceId ?? createId("src");
  const candidate: QualifiedOpportunity = {
    id: existing?.id ?? createId("intel"),
    workspaceId: business.workspaceId,
    businessId: business.businessId,
    conversation: {
      provider: state.provider,
      sourceMode: "live",
      externalId: state.externalId,
      kind: "post",
      subreddit: state.subreddit,
      title: state.title ?? undefined,
      body: state.excerpt,
      author: state.author ?? undefined,
      permalink: state.canonicalPermalink ?? undefined,
      createdAt: state.sourceCreatedAt,
      metrics: { score: 0, comments: state.commentCount },
      discoveryLanes: state.discoveryLanes,
      provenance: {
        id: sourceId,
        kind: "reddit",
        provider: state.provider,
        providerExternalId: state.externalId,
        url: state.canonicalPermalink ?? undefined,
        title: state.title ?? undefined,
        excerpt: state.excerpt.slice(0, 280),
        contentHash: state.contentHash,
        observedAt: state.sourceCreatedAt,
        isMock: false,
      },
    },
    qualification,
    classification: legacyClassificationFromDeep(qualification),
    rankScore: Math.max(0, Math.min(1, researchScore(qualification) / 100)),
    status: "new",
    provenanceIds: [sourceId],
    discoveredAt: state.sourceCreatedAt,
  };

  let content: string;
  let usage: ReturnType<typeof usageRecord> | null = null;
  try {
    const provider = createOpenAiProviderFromEnv();
    const generated = await provider.generateReply({
      business,
      opportunity: candidate,
      models: openAiModelsFromEnv(),
      instructions: qualification.replyAngle ?? undefined,
    });
    content = generated.value.body.trim();
    usage = usageRecord(generated);
  } catch (error) {
    console.error("On-demand candidate reply generation failed", error);
    throw new ApiError(
      "The AI provider could not prepare a grounded reply. No generic reply was substituted.",
      502,
      "reply_generation_failed",
    );
  }
  if (!content) {
    throw new ApiError("The AI provider returned an empty reply.", 502, "reply_generation_failed");
  }

  const now = new Date().toISOString();
  const marketIntelligence: MarketIntelligenceRecord = existing ?? {
    id: candidate.id,
    sourceId,
    externalId: state.externalId,
    title: state.title ?? "Reddit conversation signal",
    summary: qualification.whyItMatters,
    subreddit: state.subreddit,
    author: state.author,
    tags: qualification.intelligenceTags,
    demandSignals: qualification.demandSignals.filter((signal) => signal !== "none"),
    competitor: null,
    sourceCreatedAt: state.sourceCreatedAt,
    sourceIds: [sourceId],
    competitorScore: competitorScore(qualification),
    researchScore: researchScore(qualification),
    replyScore: replyScore(qualification),
  };
  const replyId = existing?.replyId ?? createId("reply");
  marketIntelligence.replyId = replyId;

  const reply: ReplyRecord = {
    id: replyId,
    opportunityId: marketIntelligence.id,
    workspaceId: input.workspaceId,
    scanId: input.scanId,
    content,
    status: "draft",
    generation: 1,
    createdAt: now,
    updatedAt: now,
    publishedAt: null,
    publishedUrl: null,
    publishedVia: null,
    redditCommentId: null,
  };
  await repository.saveReply(reply);

  const marketIntelligenceUpdated = scan.result.marketIntelligence.some((row) => row.id === marketIntelligence.id)
    ? scan.result.marketIntelligence.map((row) => (row.id === marketIntelligence.id ? marketIntelligence : row))
    : [...scan.result.marketIntelligence, marketIntelligence];

  const sourceEntry: Provenance = {
    id: sourceId,
    kind: "reddit",
    url: state.canonicalPermalink ?? "",
    title: state.title ?? "Reddit conversation",
    excerpt: state.excerpt.slice(0, 280),
    capturedAt: state.sourceCreatedAt,
    synthetic: false,
    provider: state.provider,
    sourceMode: "live",
  };
  const sourcesUpdated = scan.result.sources.some((row) => row.id === sourceId)
    ? scan.result.sources
    : [...scan.result.sources, sourceEntry];

  const updatedScan: ScanRecord = {
    ...scan,
    result: {
      ...scan.result,
      marketIntelligence: marketIntelligenceUpdated,
      sources: sourcesUpdated,
      usage: usage ? [...scan.result.usage, usage] : scan.result.usage,
    },
    updatedAt: now,
  };
  await repository.saveScan(updatedScan);

  return { marketIntelligence, reply };
}
