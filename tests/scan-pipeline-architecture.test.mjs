import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../lib/server/scan-workflow.ts", import.meta.url),
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

test("requested enrichment with zero usable conversations fails explicitly", () => {
  const guard = position("selectedForEnrichment.length > 0 && enrichment.conversations.length === 0");
  const errorCode = position('"reddit_enrichment_failed"');
  const completedStage = source.indexOf('"enrichment",\n      "complete"', guard);
  assert.ok(errorCode > guard);
  assert.ok(completedStage > errorCode, "enrichment must fail before the stage can be marked complete");
  assert.ok(source.includes("selected ${selectedForEnrichment.length}, enriched 0, failed ${failed}"));
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
