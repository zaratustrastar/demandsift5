import { randomUUID, createHash } from "node:crypto";
import { loadTsModule } from "./load-ts-module.mjs";
import { business, candidate, triage } from "../fixtures/scan-replay/factories.mjs";

/** Executes the real workflow/selection code. Only I/O boundaries are stubs. */
export async function scanWorkflowHarness(t, { count = 15, fetchLimit = 0, dropUnfetched = false, failFetch = false, worthReviewing = true, env = {}, inputMode = "context", analyzed = true, stopAtQualification = true, crawlResult = websiteEvidenceFixture() } = {}) {
  const key = `scanHarness_${randomUUID().replaceAll("-", "")}`;
  const previous = { ...process.env };
  for (const name of ["OPENAI_API_KEY", "OPENAI_DIRECT_FALLBACK_API_KEY", "OPENAI_BASE_URL", "OPENAI_DIRECT_FALLBACK_BASE_URL", "REDDIT_ENRICHMENT_BUDGET", "REDDIT_DEEP_QUALIFICATION_BUDGET", "REDDIT_MINIMUM_FULL_CONTEXT_REVIEWS", "APIFY_REDDIT_ENRICHMENT_LIMIT"]) delete process.env[name];
  Object.assign(process.env, { OPENAI_API_KEY: "fixture-key", REDDIT_PROVIDER: "harshmaur", APIFY_REDDIT_ENRICHMENT_LIMIT: String(fetchLimit), ...env });
  t.after(() => {
    delete globalThis[key];
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
  });
  const logs = [];
  t.mock.method(console, "info", value => logs.push(JSON.parse(value)));
  const rows = Array.from({ length: count }, (_, i) => candidate(`depth${i}`, { provider: "fixture", sourceMode: "live",
    body: `Our client team is missing documents and project deadlines. We need a reliable workflow for client group ${i}.` }));
  const { discoveryOnlyReview } = await loadTsModule("lib/server/scan-depth.ts");
  let scan;
  const saved = [];
  const submissions = [];
  const replies = new Map();
  const stop = new Error("fixture_stop_at_qualification");
  const result = (value, operation = "conversation_triage") => ({ value, model: "fixture-model", operation, usage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 });
  const state = {
    crawlCalls: [], analysisCalls: [],
    crawlWebsite: async (url, options) => {
      if (inputMode === "context") throw new Error("A context fixture must not crawl");
      state.crawlCalls.push({ url, options });
      return structuredClone(crawlResult);
    },
    isUsableTriageJudgment: (await loadTsModule("lib/providers/openai.server.ts")).isUsableTriageJudgment,
    models: { analysisModel: "gpt-5.6-sol", economyModel: "gpt-5.6-luna", embeddingModel: "text-embedding-3-small" },
    repository: {
      refreshScanExecution: async () => {},
      saveScan: async record => { scan = record; saved.push(structuredClone(record)); },
      beginScanRun: async () => { scan.status = "running"; return { state: "started", scan }; },
      getLatestScan: async () => null,
      saveReply: async record => { replies.set(record.id, structuredClone(record)); },
      listRepliesForScan: async scanId => [...replies.values()].filter(record => record.scanId === scanId).map(record => structuredClone(record)),
    },
    ai: {
      configurationForDiagnostics: () => ({ apiStyle: "chat", timeoutMs: 90_000, maxRetries: 2, triageBatchSize: 25, triageConcurrency: 4 }),
      analyzeBusiness: async request => {
        state.analysisCalls.push(structuredClone(request));
        const analyzedBusiness = structuredClone(business);
        analyzedBusiness.websiteUrl = request.websiteUrl;
        analyzedBusiness.canonicalDomain = request.canonicalDomain;
        for (const value of Object.values(analyzedBusiness)) {
          if (value && typeof value === "object" && "provenanceIds" in value) value.provenanceIds = request.pages.map(page => page.sourceId);
        }
        return result(analyzedBusiness);
      },
      analyzeBusinessFromContext: async () => result(structuredClone(business)),
      triageConversations: async request => {
        const value = request.candidates.map(row => ({ externalId: row.externalId, triage: triage(row.externalId, worthReviewing ? {} : { relevant: false, worthEnriching: false, intent: "informational", demandSignal: "none" }) }));
        await request.onBatchSucceeded?.(value);
        return result(value);
      },
      qualifyConversations: async request => {
        submissions.push(request);
        if (stopAtQualification) throw stop;
        return result(request.conversations.map(conversation => ({ externalId: conversation.externalId, conversation,
          qualification: { externalId: conversation.externalId, leadStatus: "potential_customer", demandSignals: ["explicit_demand"],
            intelligenceTags: ["problem_signal"], productFit: "high", painSeverity: "high", intent: "actively_looking",
            timing: "current", evidenceQuality: "high", replyability: "high", communityRisk: "low",
            problemSummary: "Missing client documents", competitorMentioned: undefined,
            whyItMatters: "The author has a current workflow problem.", shouldReply: true, autoReplyAllowed: false,
            requiresHumanReview: true, replyAngle: "Share one useful workflow step.", mentionProduct: false, disclosureRequired: false } })), "deep_qualification");
      },
      generateInsights: async () => result({ demandInsights: [], competitorSignals: [] }, "insight_generation"),
      generateReply: async request => result({ body: `A grounded fixture reply for ${request.opportunity.conversation.externalId}.` }, "reply_generation"),
    },
    reddit: {
      name: "fixture", sourceMode: "live",
      configurationForDiagnostics: () => ({ enrichmentLimit: fetchLimit }),
      discover: async () => ({ candidates: rows, sourceMode: "live", searchPlan: [], diagnostics: {
        queryCount: 1, fetchedCandidates: count, normalizedCandidates: count, verifiedRecentCandidates: count, rejectedByReason: {}, laneQueryCounts: {} } }),
      enrich: async request => {
        const selected = dropUnfetched ? request.candidates.slice(0, fetchLimit) : request.candidates;
        return { conversations: selected.map((row, i) => {
          const conversation = discoveryOnlyReview(row);
          if (!failFetch && fetchLimit > i) conversation.provenance.metadata.enriched = true;
          return conversation;
        }), sourceMode: "live", diagnostics: { requested: selected.length, enriched: failFetch ? 0 : Math.min(fetchLimit, selected.length), failed: failFetch ? selected.length : 0, fallbackUsed: 0 } };
      },
    },
  };
  globalThis[key] = state;
  const ref = `globalThis[${JSON.stringify(key)}]`;
  const workflow = await loadTsModule("lib/server/scan-workflow.ts", { moduleSources: {
    "lib/server/repository.ts": `export const getStateRepository = () => ${ref}.repository;`,
    "lib/server/http.ts": "export class ApiError extends Error { constructor(message, status, code) { super(message); this.status = status; this.code = code; } }",
    "lib/server/funnel.ts": "export async function captureFunnelEvent() {}",
    "lib/server/ai-visibility-workflow.ts": "export async function ensureAiVisibilityTrackingStarted() {}",
    "lib/security/website-crawler.ts": `export class UnsafeWebsiteUrlError extends Error {} export const crawlWebsite = (...args) => ${ref}.crawlWebsite(...args);`,
    "lib/providers/openai.server.ts": `export const createOpenAiProviderFromEnv = (env, options) => ${ref}.createAiProvider ? ${ref}.createAiProvider(env, options) : ${ref}.ai; export const openAiModelsFromEnv = () => ${ref}.models; export const isUsableTriageJudgment = ${ref}.isUsableTriageJudgment;`,
    "lib/providers/reddit.server.ts": `export const createRedditProviderFromEnv = () => ${ref}.reddit;`,
  } });
  scan = await workflow.createScan("fixture_workspace", inputMode === "website"
    ? { websiteUrl: crawlResult.requestedUrl }
    : { contextText: "We help client teams find missing documents and track deadlines." });
  if (analyzed) scan.discoveryProfile = { business: structuredClone(business), profile: { name: "Fixture business",
    sourceIds: inputMode === "website" ? crawlResult.pages.map(page => `web_${page.contentHash.slice(0, 20)}`) : ["fixture_context"] },
    analysisMode: "openai", analyzedAt: new Date().toISOString(), profileStage: "full" };
  if (analyzed && inputMode === "website") {
    for (const value of Object.values(scan.discoveryProfile.business)) {
      if (value && typeof value === "object" && "provenanceIds" in value) value.provenanceIds = [...scan.discoveryProfile.profile.sourceIds];
    }
  }
  return { workflow, scan, saved, submissions, replies, stop, logs, state, rows };
}

export function websiteEvidenceFixture(pageCount = 4) {
  return { requestedUrl: "https://fixture-business.com/", canonicalUrl: "https://fixture-business.com/", canonicalDomain: "fixture-business.com",
    totalBytes: 2000, failures: [], pages: Array.from({ length: pageCount }, (_, i) => {
      const text = `Client document tracking and deadline workflows for accounting teams. This is original synthetic public-page evidence number ${i}.`;
      return { url: `https://fixture-business.com/${i === 0 ? "" : `page-${i}`}`, title: `Fixture page ${i}`, text,
        contentHash: createHash("sha256").update(text).digest("hex"), retrievedAt: "2026-08-31T12:00:00.000Z" };
    }) };
}
