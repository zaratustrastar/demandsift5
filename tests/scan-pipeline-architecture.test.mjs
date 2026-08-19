import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../lib/server/scan-workflow.ts", import.meta.url),
  "utf8",
);
const executorRoute = await readFile(
  new URL("../app/api/internal/jobs/[jobId]/execute/route.ts", import.meta.url),
  "utf8",
);
const scanStatusRoute = await readFile(
  new URL("../app/api/scans/[scanId]/route.ts", import.meta.url),
  "utf8",
);

function position(fragment) {
  const index = source.indexOf(fragment);
  assert.notEqual(index, -1, `Expected active scan source to contain ${fragment}`);
  return index;
}

test("active scan orders discovery before triage before enrichment before deep qualification", () => {
  const discovery = position("redditProvider.discover(");
  const triage = position("aiProvider.triageConversations(");
  const enrichment = position("redditProvider.enrich(");
  const qualification = position("aiProvider.qualifyConversations(");
  assert.ok(discovery < triage);
  assert.ok(triage < enrichment);
  assert.ok(enrichment < qualification);
});

test("long-running scans start durably and recover an orphaned running execution", () => {
  assert.equal(executorRoute.includes("ReadableStream"), false);
  assert.match(executorRoute, /activeScanExecutions/);
  assert.match(executorRoute, /ensureClaimedScanExecution\(scan\.id, false, job\.attempts, job\.maxAttempts\)/);
  assert.match(executorRoute, /ensureClaimedScanExecution\(scan\.id, true, job\.attempts, job\.maxAttempts\)/);
  assert.match(executorRoute, /status: "starting", complete: false/);
  assert.match(executorRoute, /export async function GET/);
  assert.match(executorRoute, /executionSnapshot\(job, scan\)/);
  assert.match(source, /resumeRunning\?: boolean;/);
  assert.match(source, /stopAfterUnderstanding\?: boolean;/);
  assert.match(source, /jobAttempts\?: number;/);
  assert.match(source, /jobMaxAttempts\?: number;/);
  assert.match(source, /claim\.state === "running" && !options\.resumeRunning/);
});

test("running scan polling does not invoke completed-report presentation", () => {
  const statusGuard = scanStatusRoute.indexOf("if (statusOnly || !scan.result)");
  const presenter = scanStatusRoute.indexOf("await presentScan(scan)");
  assert.ok(statusGuard >= 0);
  assert.ok(presenter > statusGuard);
  assert.match(scanStatusRoute, /report: null/);
  assert.match(scanStatusRoute, /searchParams\.get\("statusOnly"\) === "1"/);
});

test("the MVP is a single on-demand scan over the previous 7 days", () => {
  assert.match(source, /const lookbackDays = 7;/);
  assert.match(source, /lookbackDays \* 86_400_000/);
  assert.match(source, /windowDays: lookbackDays/);
  // Review depth must not ride on the window.
  assert.equal(/minimumFullContextReviews\(lookbackDays\)/.test(source), false);
});

test("completing a scan does not schedule another scan", () => {
  // The MVP is user-triggered only. `enqueueScanRun` exists for the initial
  // POST /api/scans enqueue, so the check is that nothing in the run path
  // schedules a successor once a scan finishes.
  const runScanAt = source.indexOf("export async function runScan");
  assert.ok(runScanAt > 0, "runScan not found");
  const runPath = source.slice(runScanAt);
  for (const fragment of ["enqueueScanRun(", "enqueueScan(", "setInterval(", "cron"]) {
    assert.equal(
      runPath.includes(fragment),
      false,
      `the scan run path should not contain ${fragment}`,
    );
  }
});

test("acquisition retrieves a corpus rather than a handful of candidates", () => {
  assert.match(source, /acquisitionCandidateTarget\(\)/);
  assert.equal(source.includes("limit: 25,"), false);
});

test("active scan does not use legacy deterministic ranking", () => {
  assert.equal(source.includes("rankConversations("), false);
  assert.equal(source.includes("candidateDiscoveryScore"), false);
  assert.equal(source.includes("semanticSimilarities"), false);
});

/**
 * Embeddings were previously banned here because the pipeline only handled
 * 30-50 candidates and cosine similarity used as a relevance *decision* loses
 * indirectly expressed pain. Acquisition is now 200-300 candidates, so they
 * return strictly as a high-recall prefilter: they order candidates and drop
 * the obviously unrelated tail, while the LLM still decides relevance.
 */
test("embeddings prefilter candidates before classification but never decide relevance", () => {
  const prefilter = position("prioritizeCandidates(");
  const triage = position("aiProvider.triageConversations(");
  assert.ok(prefilter < triage, "prefilter must run before LLM classification");

  // The prefilter only narrows the pool; it must not set relevance or score.
  assert.equal(source.includes("relevant: similarity"), false);
  assert.equal(source.includes("solutionFit: similarity"), false);

  // Cheap deterministic cleaning still runs first.
  assert.ok(position("cleanDiscoveryCandidates(") < prefilter);

  // Failure of the embedding layer must not drop candidates.
  assert.match(source, /let prefilteredSurvivors = cleaned\.survivors;/);
  assert.match(source, /Embedding prefilter unavailable/);
});

test("the classified pool is bounded so acquisition volume cannot blow up LLM cost", () => {
  assert.match(source, /triageCandidateBudget\(\)/);
  assert.match(source, /classifiedCandidates: prefilteredSurvivors\.length/);
});

test("active scan does not use batch reply generation", () => {
  assert.equal(source.includes("generateRepliesWithOpenAi"), false);
  assert.equal(source.includes("generateReplies("), false);
  assert.ok(source.includes("aiProvider.generateReply("));
});

test("deterministic lead invariants are checked before ranking is calculated", () => {
  const leadDecision = position("isQualifiedPotentialCustomer(qualification)");
  const ranking = position("opportunityRankScore(qualification)");
  assert.ok(leadDecision < ranking);
});

test("paid Reddit discovery failures surface a terminal machine-readable error", () => {
  const discovery = position("redditProvider.discover(");
  const errorCode = source.indexOf('"reddit_discovery_failed"', discovery);
  const cleaning = source.indexOf("cleanDiscoveryCandidates(", discovery);
  assert.ok(errorCode > discovery);
  assert.ok(cleaning > errorCode, "discovery failure must be classified before local cleaning starts");
  assert.ok(source.includes("Reddit discovery failed: ${message}"));
});

test("incomplete Reddit thread expansion retries replacements and continues with limited coverage", () => {
  assert.ok(source.includes("requiredFullContextReviews"));
  assert.ok(source.includes("enrichmentReplacementAttempts"));
  assert.ok(source.includes("enrichmentReplacementSuccesses"));
  assert.ok(source.includes("coverageLimited"));
  assert.ok(source.includes("hasVerifiedThreadContext"));
  assert.equal(source.includes('throw new ApiError(detail, 502, "reddit_enrichment_failed")'), false);
});

test("deep qualification is reused only after source and structured context are verified unchanged", () => {
  assert.equal(
    source.includes("previous.deepQualification && previous.commentCount === candidate.metrics.comments"),
    false,
    "comment count must never be used as proof that thread context is unchanged",
  );
  assert.equal(
    source.includes("deep?.qualification ?? previous?.deepQualification"),
    false,
    "processed state must not silently carry a stale deep qualification forward",
  );
  assert.ok(source.includes("const currentContextHash = structuredContextHash(conversation)"));
  assert.ok(source.includes("previous.contentHash === candidate.provenance.contentHash"));
  assert.ok(source.includes("previous.contextHash === currentContextHash"));
  assert.ok(source.includes("sourceUnchanged && contextUnchanged && previous?.deepQualification"));
  assert.ok(source.includes("conversations: conversationsNeedingDeep"));
  assert.ok(source.includes("deepQualification: deep?.qualification ?? null"));
  assert.ok(source.includes("const contextHash = deep ? structuredContextHash(deep.conversation) : null"));
});

test("reply reuse also requires the verified current context hash", () => {
  assert.equal(source.includes("state.commentCount === row.conversation.metrics.comments"), false);
  assert.ok(source.includes("state.contextHash === currentContextHash"));
});

test("scan persists mandatory stage diagnostics and recurring state", () => {
  for (const field of [
    "deterministicSurvivors",
    "submittedForTriage",
    "triageReturned",
    "worthEnriching",
    "requestedForEnrichment",
    "enrichedSuccessfully",
    "submittedForDeepQualification",
    "potentialCustomerConversations",
    "marketIntelligenceSignals",
    "uniquePotentialCustomers",
    "replyEligible",
    "repliesGenerated",
    "processedRedditState",
    "searchPlan: discovery.searchPlan",
    "queryCountsByLane: discovery.diagnostics.laneQueryCounts",
    "matchedCandidatesByLane",
    "worthEnrichingByLane",
    "matchedCandidatesByQuery",
    "worthEnrichingByQuery",
    "matchedQueries: candidate.matchedQueries",
    "discoveryLanes: candidate.discoveryLanes",
  ]) {
    assert.ok(source.includes(field), `missing ${field}`);
  }
});


test("unchanged negative triage is re-evaluated instead of becoming a permanent blind spot", () => {
  assert.match(source, /previous\.triage\.worthEnriching === true/);
  assert.equal(
    source.includes("if (previous && previous.contentHash === candidate.provenance.contentHash)"),
    false,
  );
});

test("zero-result scans audit a bounded high-signal sample before accepting a triage false zero", async () => {
  const source = await readFile(new URL("../lib/server/scan-workflow.ts", import.meta.url), "utf8");
  assert.match(source, /const zeroResultAuditCandidates = worthEnriching\.length === 0/);
  assert.match(source, /selectZeroResultAuditCandidates/);
  assert.match(source, /budget: Math\.min\(previousResult \? 2 : 3, enrichmentBudget\(\)\)/);
});

test("thread context verifier is initialized before enrichment recovery uses it", () => {
  const verifier = position("const hasVerifiedThreadContext =");
  const initialEnrichment = position("const initialEnrichment = await redditProvider.enrich(");
  const absorb = position("const absorbEnrichment =");
  assert.ok(verifier < initialEnrichment);
  assert.ok(verifier < absorb);
});

test("recurring monitoring is disabled unless explicitly enabled", async () => {
  const worker = await readFile(
    new URL("../scripts/background-worker.mjs", import.meta.url),
    "utf8",
  );
  const { monitoringSchedulerEnabled } = await import("../scripts/background-worker.mjs");
  assert.equal(monitoringSchedulerEnabled({}), false, "scheduler must be off by default");
  assert.equal(monitoringSchedulerEnabled({ MONITORING_SCHEDULER_ENABLED: "true" }), true);
  assert.match(worker, /monitoringSchedulerEnabled\(\)\s*\?\s*runMonitoringScheduler/);
});
