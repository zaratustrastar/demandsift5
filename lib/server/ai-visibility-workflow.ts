import type { BusinessUnderstanding } from "@/lib/domain/types";
import { createOpenAiProviderFromEnv, openAiModelsFromEnv } from "@/lib/providers/openai.server";
import { runAllVisibilityActors } from "@/lib/providers/ai-visibility-apify.server";
import {
  brandMentioned,
  competitorsMentioned,
  computeVisibilityMetrics,
  mentionPosition,
  otherCitedDomains,
  redditCitations,
} from "@/lib/server/ai-visibility-analysis";
import {
  completeAiVisibilityScan,
  createAiVisibilitySettings,
  failAiVisibilityScan,
  getAiVisibilityScan,
  getAiVisibilitySettings,
  nextMonday,
  saveAiVisibilityScan,
} from "@/lib/server/ai-visibility-repository";
import type {
  AiVisibilityAiProvider,
  AiVisibilityAnswer,
  AiVisibilityScanRecord,
  CompetitorProfile,
  ScanRecord,
} from "@/lib/server/contracts";
import { getStateRepository } from "@/lib/server/repository";

/**
 * AI Visibility Tracking orchestration -- a sidecar, isolated from
 * scan-workflow.ts's Reddit discovery/qualification/reply pipeline. Nothing
 * here is called from, or calls into, that pipeline beyond reading the
 * already-finished business profile and competitor data it produced.
 */

const PROVIDERS: AiVisibilityAiProvider[] = ["chatgpt", "gemini", "perplexity"];

/**
 * Called once, right after a primary (non-monitoring) scan reaches
 * `status: "complete"` -- see the call site in scan-workflow.ts. Seeds the
 * weekly (Monday) schedule for the workspace exactly once, disabled by
 * default (`enabled: false`, see createAiVisibilitySettings): no scan is
 * enqueued here, and the weekly scheduler's own `enabled = true` filter
 * (scheduleAiVisibilityScans in scripts/background-worker.mjs) means a
 * disabled schedule never runs on its own either. There is currently no
 * dashboard control that flips it to enabled -- until one exists, this
 * seeds a dormant row rather than silently tracking a business that never
 * asked for it. If a schedule already exists for this workspace (a later
 * scan completing, or two concurrent completions), this is a no-op.
 *
 * Deliberately best-effort: any failure here is caught by the caller and
 * never allowed to fail the primary scan it rides on.
 */
export async function ensureAiVisibilityTrackingStarted(scan: ScanRecord): Promise<void> {
  const repository = getStateRepository();
  if (repository.kind !== "postgres") return; // dev/test memory store: no durable job queue to enqueue into.
  const existing = await getAiVisibilitySettings(scan.workspaceId);
  if (existing) return;
  await createAiVisibilitySettings({
    workspaceId: scan.workspaceId,
    seedScanId: scan.id,
    nextRunAt: nextMonday(new Date()),
  });
}

/**
 * Enqueues the next weekly run for every workspace whose schedule is due.
 * Called by the background worker's poller (scripts/background-worker.mjs),
 * mirroring scheduleRedditMonitorScans -- see runAiVisibilityScheduler
 * there for the polling loop itself. The actual SQL lives there (matching
 * where the other two schedulers already live) since it needs the same
 * `sql` transaction handle the worker process holds; this module owns the
 * scan execution, not the SQL scheduling query.
 */

function readableModels() {
  return openAiModelsFromEnv();
}

function readableAiProvider() {
  return process.env.OPENAI_API_KEY?.trim() ? createOpenAiProviderFromEnv() : null;
}

function readyCompetitors(competitorProfiles: CompetitorProfile[] | null | undefined): CompetitorProfile[] {
  return (competitorProfiles ?? []).filter((competitor) => competitor.status === "ready");
}

/** Naive fallback when no AI provider is configured -- keeps local/dev/test runs working without an API key. */
function conservativeQuestions(business: BusinessUnderstanding, competitors: CompetitorProfile[]): string[] {
  const category = business.productCategory.value.trim() || "this kind of product";
  const alternative = competitors[0]?.name.trim() || category;
  const problem = business.customerProblemLanguage.value[0]?.trim() || `problems ${category} solves`;
  return [
    `best ${category} for small teams`,
    `best alternatives to ${alternative}`,
    `how to solve ${problem}`,
  ];
}

async function generateQuestions(
  business: BusinessUnderstanding,
  competitors: CompetitorProfile[],
): Promise<string[]> {
  const aiProvider = readableAiProvider();
  if (!aiProvider) return conservativeQuestions(business, competitors);
  const generated = await aiProvider.generateVisibilityQuestions({
    productCategory: business.productCategory.value,
    brandName: business.name.value,
    customerProblemLanguage: business.customerProblemLanguage.value.slice(0, 8),
    competitorNames: [
      ...competitors.map((competitor) => competitor.name),
      ...business.competitors.value.map((competitor) => competitor.name),
    ].slice(0, 8),
    workspaceId: business.workspaceId,
    businessId: business.businessId,
    models: readableModels(),
  });
  return generated.value.questions;
}

/** Brand terms used for deterministic mention matching: the verified name plus any brand/product terms. */
function brandTermsFor(business: BusinessUnderstanding): string[] {
  return [...new Set([business.name.value, ...business.brandTerms.value].map((term) => term.trim()).filter(Boolean))];
}

function competitorNamesFor(business: BusinessUnderstanding, competitors: CompetitorProfile[]): string[] {
  return [
    ...new Set(
      [...competitors.map((competitor) => competitor.name), ...business.competitors.value.map((competitor) => competitor.name)]
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
}

export async function runAiVisibilityScan(visibilityScanId: string): Promise<AiVisibilityScanRecord> {
  let record = await getAiVisibilityScan(visibilityScanId);
  if (!record) throw new Error("AI visibility scan was not found.");
  if (record.status === "succeeded") return record;

  try {
    const repository = getStateRepository();
    const seed = await repository.getScan(record.seedScanId);
    if (!seed || seed.workspaceId !== record.workspaceId || seed.status !== "complete" || !seed.discoveryProfile) {
      throw new Error("AI visibility tracking requires an owned, completed business scan.");
    }
    const business = seed.discoveryProfile.business;
    const competitors = readyCompetitors(seed.competitorProfiles);
    const ownDomain = business.canonicalDomain;

    record = { ...record, status: "running", error: null, updatedAt: new Date().toISOString() };
    await saveAiVisibilityScan(record);

    const questions = await generateQuestions(business, competitors);
    if (questions.length !== 3) {
      throw new Error(`Expected exactly 3 visibility questions, got ${questions.length}.`);
    }
    record = { ...record, questions, updatedAt: new Date().toISOString() };
    await saveAiVisibilityScan(record);

    const apifyToken = process.env.APIFY_TOKEN?.trim();
    const missingTokenMessage = "APIFY_TOKEN is not configured on the server, so no AI visibility Actor could run.";
    const actorResults = apifyToken
      ? await runAllVisibilityActors({ questions, token: apifyToken })
      : PROVIDERS.map((provider) => ({
          provider,
          actorRunId: null,
          answers: [],
          failedQuestions: [...questions],
          error: missingTokenMessage,
        }));

    const providerErrors: Record<AiVisibilityAiProvider, string | null> = {
      chatgpt: null,
      gemini: null,
      perplexity: null,
    };
    for (const result of actorResults) {
      if (result.error) providerErrors[result.provider] = result.error;
    }

    const brandTerms = brandTermsFor(business);
    const competitorNames = competitorNamesFor(business, competitors);
    const now = new Date().toISOString();

    // Deterministic pass first, for every (provider, question) pair --
    // including ones the Actor failed to answer, so the scan always has
    // exactly 9 stored rows (3 questions x 3 providers), same as the spec's
    // "9 AI answers total" expectation, even when a provider comes back
    // partial.
    const draftAnswers: AiVisibilityAnswer[] = [];
    for (const result of actorResults) {
      for (const question of questions) {
        const raw = result.answers.find((answer) => answer.question === question);
        const answerText = raw?.answerText ?? "";
        const citations = raw?.citations ?? [];
        draftAnswers.push({
          provider: result.provider,
          question,
          answerText,
          citations,
          model: raw?.model ?? null,
          actorRunId: result.actorRunId,
          brandMentioned: answerText ? brandMentioned(answerText, brandTerms) : false,
          mentionPosition: answerText ? mentionPosition(answerText, brandTerms) : "not_mentioned",
          brandRecommended: false,
          recommendationReasoning: null,
          competitorsMentioned: answerText ? competitorsMentioned(answerText, competitorNames) : [],
          redditCitations: redditCitations(citations),
          otherDomains: otherCitedDomains(citations, ownDomain),
          fetchedAt: now,
        });
      }
    }

    // Semantic pass second: only for answers that actually mention the
    // brand and have real text -- there is nothing to recommend in an empty
    // or brandless answer, and skipping those keeps the batch (and the
    // AI spend) proportional to what could possibly be a recommendation.
    const toClassify = draftAnswers
      .map((answer, index) => ({ answer, index }))
      .filter(({ answer }) => answer.brandMentioned && answer.answerText.trim());
    const aiProvider = readableAiProvider();
    if (aiProvider && toClassify.length > 0) {
      const analyzed = await aiProvider.analyzeVisibilityMentions({
        brandName: business.name.value,
        answers: toClassify.map(({ answer, index }) => ({ index, question: answer.question, answerText: answer.answerText })),
        models: readableModels(),
        workspaceId: business.workspaceId,
        businessId: business.businessId,
      });
      const byIndex = new Map(analyzed.value.map((item) => [item.index, item]));
      for (const { index } of toClassify) {
        const classification = byIndex.get(index);
        if (!classification) continue;
        draftAnswers[index] = {
          ...draftAnswers[index],
          brandRecommended: classification.brandRecommended,
          recommendationReasoning: classification.reasoning,
        };
      }
    }

    const metrics = computeVisibilityMetrics(draftAnswers);
    record = {
      ...record,
      answers: draftAnswers,
      metrics,
      providerErrors,
      updatedAt: new Date().toISOString(),
    };
    await completeAiVisibilityScan(record);
    return (await getAiVisibilityScan(record.id)) ?? { ...record, status: "succeeded" };
  } catch (error) {
    await failAiVisibilityScan(record, error);
    throw error;
  }
}
