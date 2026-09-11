import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./helpers/load-ts-module.mjs";
import { scanWorkflowHarness } from "./helpers/scan-workflow-harness.mjs";
import { business, candidate } from "./fixtures/scan-replay/factories.mjs";

const { replyInputVersion } = await loadTsModule("lib/ai/reply-checkpoint.ts");
const { discoveryOnlyReview } = await loadTsModule("lib/server/scan-depth.ts");

const providerResult = (value, operation) => ({ value, operation, model: "fixture-model",
  usage: { inputTokens: 10, outputTokens: 5 }, estimatedCostUsd: 0 });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test("qualified cards persist before insights and replies, whose provider work overlaps", { skip: "SCAN_SPEED_KILL_SWITCH permanently disables partialResults; this test exercises the now-retired incremental-publish path through the real workflow" }, async t => {
  const fixture = await scanWorkflowHarness(t, { count: 5, stopAtQualification: false, env: { SCAN_PARTIAL_RESULTS: "1" } });
  const windows = { insight: null, replies: [] };
  fixture.state.ai.generateInsights = async () => {
    const window = { start: Date.now(), end: 0 }; windows.insight = window;
    await delay(80); window.end = Date.now();
    return providerResult({ demandInsights: [], competitorSignals: [] }, "insight_generation");
  };
  fixture.state.ai.generateReply = async request => {
    const window = { id: request.opportunity.conversation.externalId, start: Date.now(), end: 0 }; windows.replies.push(window);
    await delay(30); window.end = Date.now();
    return providerResult({ body: `Grounded reply for ${window.id}` }, "reply_generation");
  };
  const completed = await fixture.workflow.runScan(fixture.scan.id);
  assert.equal(completed.status, "complete");
  assert.ok(fixture.saved.some(row => Object.keys(row.partialResults?.qualified ?? {}).length > 0
    && Object.values(row.partialResults?.replies ?? {}).every(reply => reply.state !== "ready")),
  "qualified output must be durable before tail decoration finishes");
  assert.ok(windows.insight && windows.replies.some(window => window.start < windows.insight.end && windows.insight.start < window.end),
    "at least one reply request should overlap insight generation");
  assert.equal(Object.values(completed.partialResults.qualified).filter(row => row.kind === "potential_customer").length, completed.result.opportunities.length);
  assert.equal(Object.values(completed.partialResults.replies).filter(row => row.state === "ready").length, completed.result.replies.length);
});

test("restart reuses every exact successful reply and retries only the failed draft", { skip: "SCAN_SPEED_KILL_SWITCH permanently disables partialResults; this test exercises the now-retired incremental-publish path through the real workflow" }, async t => {
  const fixture = await scanWorkflowHarness(t, { count: 5, stopAtQualification: false, env: { SCAN_PARTIAL_RESULTS: "1" } });
  let broken = true; const calls = [];
  fixture.state.ai.generateReply = async request => {
    const id = request.opportunity.conversation.externalId; calls.push(id);
    await delay(id === "depth2" ? 5 : 15);
    if (broken && id === "depth2") throw new Error("fixture reply failure");
    return providerResult({ body: `Grounded reply for ${id}` }, "reply_generation");
  };
  await assert.rejects(fixture.workflow.runScan(fixture.scan.id), /fixture reply failure/);
  assert.equal(Object.keys(fixture.scan.replyCheckpoint).length, 4);
  assert.equal(Object.values(fixture.scan.partialResults.replies).filter(row => row.state === "ready").length, 4);
  assert.equal(Object.values(fixture.scan.partialResults.replies).filter(row => row.state === "failed").length, 1);
  broken = false; calls.length = 0;
  const completed = await fixture.workflow.runScan(fixture.scan.id, { resumeRunning: true });
  assert.deepEqual(calls, ["depth2"]);
  assert.equal(completed.status, "complete");
  assert.equal(Object.keys(completed.replyCheckpoint).length, 5);
  assert.equal(Object.values(completed.partialResults.replies).filter(row => row.state === "ready").length, 5);
});

test("reply checkpoint identity covers profile, model, source/context, qualification and instructions", () => {
  const row = discoveryOnlyReview(candidate("reply-version"));
  const qualification = { externalId: row.externalId, leadStatus: "potential_customer", demandSignals: ["explicit_demand"],
    intelligenceTags: ["problem_signal"], productFit: "high", painSeverity: "high", intent: "actively_looking", timing: "current",
    evidenceQuality: "high", replyability: "high", communityRisk: "low", problemSummary: "Missing documents",
    whyItMatters: "Current pain", shouldReply: true, autoReplyAllowed: false, requiresHumanReview: true,
    replyAngle: "Offer one step", mentionProduct: false, disclosureRequired: false };
  const models = { analysisModel: "gpt-5.6-sol", economyModel: "gpt-5.6-luna", embeddingModel: "text-embedding-3-small" };
  const input = { business, models, conversation: row, qualification, instructions: qualification.replyAngle };
  const version = replyInputVersion(input);
  assert.equal(version, replyInputVersion(structuredClone(input)));
  assert.notEqual(version, replyInputVersion({ ...input, business: { ...business, version: 99 } }));
  assert.notEqual(version, replyInputVersion({ ...input, models: { ...models, analysisModel: "other" } }));
  assert.notEqual(version, replyInputVersion({ ...input, conversation: { ...row, body: `${row.body} richer` } }));
  assert.notEqual(version, replyInputVersion({ ...input, qualification: { ...qualification, replyAngle: "Different" } }));
  assert.notEqual(version, replyInputVersion({ ...input, instructions: "Different" }));
});
