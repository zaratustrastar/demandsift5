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
  // The single-page report states this plainly next to the (now primary)
  // relevant-posts list rather than in a separate metrics hero.
  assert.match(dashboard, /No relevant Reddit posts or comments were found in this scan\./);
  assert.match(presenter, /qualificationCoverage/);
});

test("every displayed acquisition opportunity passes deterministic lead invariants and receives a complete draft", async () => {
  const [workflow, pipeline] = await Promise.all([
    source("lib/server/scan-workflow.ts"),
    source("lib/intelligence/reddit-pipeline.ts"),
  ]);
  assert.match(workflow, /isQualifiedPotentialCustomer\(qualification\)/);
  assert.match(pipeline, /export function isQualifiedPotentialCustomer/);
  assert.match(pipeline, /qualification\.leadStatus === "potential_customer"/);
  assert.match(pipeline, /qualification\.shouldReply === true/);
  assert.match(pipeline, /qualification\.evidenceQuality === "high"/);
  assert.match(pipeline, /qualification\.productFit === "medium" \|\| qualification\.productFit === "high"/);
  assert.match(pipeline, /qualification\.replyability === "medium" \|\| qualification\.replyability === "high"/);
  // Lead and non-lead replies share one bounded queue, while lead tasks retain
  // strict failure semantics so no displayed acquisition result can finish
  // without its complete grounded reply.
  assert.match(workflow, /const replyTasks = \[\.\.\.leadTasks, \.\.\.relevantTasks\]/);
  assert.match(workflow, /mapConcurrently\(replyTasks, REPLY_GENERATION_CONCURRENCY/);
  assert.match(workflow, /if \(task\.strict\) throw error/);
  assert.doesNotMatch(workflow, /Create empty placeholders only for additional reply-eligible paid results/);
  assert.match(workflow, /const leadTasks: ReplyTask\[\] = replyEligible\.flatMap/);
});


test("market-intelligence review has a bounded full-context floor independent of lead triage", async () => {
  const [workflow, pipeline] = await Promise.all([
    source("lib/server/scan-workflow.ts"),
    source("lib/intelligence/reddit-pipeline.ts"),
  ]);
  // The floor is now independent of the lookback window as well as of lead
  // triage: shortening the window to 7 days must not lower review depth.
  assert.match(workflow, /function minimumFullContextReviews\(env: NodeJS.ProcessEnv = process.env\): number/);
  assert.match(workflow, /minimumFullContextReviews\(env\)/);
  assert.equal(/minimumFullContextReviews\(lookbackDays\)/.test(workflow), false);
  // Enrichment must be over-selected so one miss cannot fail a healthy scan.
  assert.match(workflow, /enrichmentSelectionTarget/);
  // Misses are recovered by enriching a replacement candidate rather than by
  // tolerating a shortfall, so the confidence target is met and not lowered.
  assert.match(workflow, /const replacementCandidate =/);
  assert.match(workflow, /verifiedContextCount\(\) < requiredFullContextReviews/);
  // A shortfall degrades to a limited-coverage result, never a definitive zero.
  assert.match(workflow, /coverageLimited/);
  assert.equal(
    /allowedEnrichmentFailures/.test(workflow),
    false,
    "the failure-tolerance helper was superseded by replacement enrichment",
  );
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


test("context coverage counts only verified enrichment and degrades to limited coverage after bounded recovery", async () => {
  const [workflow, presenter, dashboard] = await Promise.all([
    source("lib/server/scan-workflow.ts"),
    source("lib/server/presenter.ts"),
    source("components/demand-intelligence/ProductDashboard.tsx"),
  ]);
  assert.match(workflow, /verifiedContextCount\(\) < requiredFullContextReviews/);
  assert.match(workflow, /enrichmentReplacementAttempts/);
  assert.match(workflow, /coverageLimited/);
  assert.match(workflow, /hasVerifiedThreadContext/);
  assert.doesNotMatch(workflow, /throw new ApiError\(detail, 502, "reddit_enrichment_failed"\)/);
  assert.match(presenter, /fullContextReviewed: result\.diagnostics\.enrichedSuccessfully/);
  // The bounded-coverage narrative that used to sit in the dashboard hero was
  // removed with that hero; the underlying honesty guarantee (never report a
  // definitive zero off partial coverage) is still enforced and asserted
  // above at the workflow/presenter layer, which is what actually decides it.
  assert.doesNotMatch(dashboard, /credible recent candidates with full conversation context/);
});
