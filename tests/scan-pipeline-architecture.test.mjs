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
  assert.match(executorRoute, /ensureClaimedScanExecution\(scan\.id, false\)/);
  assert.match(executorRoute, /ensureClaimedScanExecution\(scan\.id, true\)/);
  assert.match(executorRoute, /status: "starting", complete: false/);
  assert.match(executorRoute, /export async function GET/);
  assert.match(executorRoute, /executionSnapshot\(job, scan\)/);
  assert.match(source, /options: \{ resumeRunning\?: boolean \} = \{\}/);
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

test("the acquisition scan uses a 30-day baseline while monitoring stays incremental", () => {
  assert.match(source, /const lookbackDays = previousResult \? 7 : 30/);
  assert.match(source, /lookbackDays \* 86_400_000/);
  assert.match(source, /windowDays: lookbackDays/);
});

test("active scan does not use embeddings or legacy deterministic ranking", () => {
  assert.equal(source.includes("embedTextsWithOpenAi"), false);
  assert.equal(source.includes(".embed("), false);
  assert.equal(source.includes("rankConversations("), false);
  assert.equal(source.includes("candidateDiscoveryScore"), false);
  assert.equal(source.includes("semanticSimilarities"), false);
});

test("active scan does not use batch reply generation", () => {
  assert.equal(source.includes("generateRepliesWithOpenAi"), false);
  assert.equal(source.includes("generateReplies("), false);
  assert.ok(source.includes("aiProvider.generateReply("));
});

test("categorical lead status is checked before ranking is calculated", () => {
  const leadDecision = position('qualification.leadStatus !== "potential_customer"');
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

test("optional Reddit thread expansion cannot abort a verified discovery scan", () => {
  assert.equal(source.includes('"reddit_enrichment_failed"'), false);
  assert.equal(source.includes("enrichment.diagnostics.fallbackUsed"), true);
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
