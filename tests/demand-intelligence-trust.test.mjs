import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL("../" + path, import.meta.url), "utf8");
}

test("negative deep qualification is re-evaluated instead of becoming sticky", async () => {
  const workflow = await source("lib/server/scan-workflow.ts");
  assert.match(workflow, /previous\.deepQualification\.leadStatus !== "not_customer"/);
});

test("demand claims are scoped to reviewed Reddit provenance", async () => {
  const [provider, workflow, contracts] = await Promise.all([
    source("lib/providers/openai.server.ts"),
    source("lib/server/scan-workflow.ts"),
    source("lib/server/contracts.ts"),
  ]);
  const insightMethod = provider.slice(provider.indexOf("async generateInsights"), provider.indexOf("async generateReply"));
  const allowedIdsBlock = insightMethod.slice(insightMethod.indexOf("const allowedIds"), insightMethod.indexOf("return this.structured"));
  assert.doesNotMatch(allowedIdsBlock, /request\.business/);
  assert.match(workflow, /reviewedRedditSourceIds/);
  assert.match(workflow, /seenEvidenceSets/);
  assert.match(contracts, /evidenceScope: "single-conversation" \| "recurring-pattern"/);
});

test("generated competitor names must pass deterministic source verification", async () => {
  const workflow = await source("lib/server/scan-workflow.ts");
  assert.match(workflow, /identifyVerifiedCompetitorSignal\(\{/);
  assert.match(workflow, /normalizedCompetitorName\(verified\.competitor\)/);
  assert.match(workflow, /normalizedCompetitorName\(signal\.competitorName\)/);
});

test("zero-result reporting states bounded qualification coverage and evidence links", async () => {
  const [dashboard, presenter] = await Promise.all([
    source("components/demand-intelligence/ProductDashboard.tsx"),
    source("lib/server/presenter.ts"),
  ]);
  assert.match(dashboard, /No candidates passed qualification in this scan\./);
  assert.match(dashboard, /fullContextReviewed/);
  assert.match(dashboard, /View public source/);
  assert.match(presenter, /qualificationCoverage/);
});

test("every displayed acquisition opportunity is replyable and receives a complete draft", async () => {
  const workflow = await source("lib/server/scan-workflow.ts");
  assert.match(
    workflow,
    /qualification\.leadStatus !== "potential_customer" \|\|\s*qualification\.shouldReply !== true/,
  );
  assert.match(workflow, /for \(const opportunity of replyEligible\)/);
  assert.doesNotMatch(workflow, /Create empty placeholders only for additional reply-eligible paid results/);
  assert.match(workflow, /all qualified opportunities/);
});


test("market-intelligence review has a bounded full-context floor independent of lead triage", async () => {
  const [workflow, pipeline] = await Promise.all([
    source("lib/server/scan-workflow.ts"),
    source("lib/intelligence/reddit-pipeline.ts"),
  ]);
  assert.match(workflow, /minimumFullContextReviews\(lookbackDays\)/);
  assert.match(workflow, /intelligenceCoverageReviews/);
  assert.match(pipeline, /selectCandidatesForIntelligenceReview/);
  assert.match(pipeline, /const laneOrder: RedditSearchLane\[\]/);
  assert.match(pipeline, /triage\.intent === "irrelevant" \|\| triage\.intent === "promotional"/);
});


test("relevant conversations are source-linked and kept separate from reply-ready leads", async () => {
  const [presenter, dashboard, mapper] = await Promise.all([
    source("lib/server/presenter.ts"),
    source("components/demand-intelligence/ProductDashboard.tsx"),
    source("components/demand-intelligence/from-scan.ts"),
  ]);
  assert.match(presenter, /!leadSourceIds\.has\(conversation\.sourceId\)/);
  assert.match(presenter, /publicRelevantConversation/);
  assert.match(presenter, /permalink: source\?\.url \|\| null/);
  assert.match(presenter, /relevantConversations: relevantConversations\.length/);
  assert.match(dashboard, /Research signal — not a lead/);
  assert.match(dashboard, /It is not counted as a potential customer and has no generated reply/);
  assert.match(mapper, /relevantConversations: \(report\.relevantConversations \?\? \[\]\)\.map/);
});
