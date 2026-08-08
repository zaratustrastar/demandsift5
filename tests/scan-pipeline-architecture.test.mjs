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
  ]) {
    assert.ok(source.includes(field), `missing ${field}`);
  }
});
