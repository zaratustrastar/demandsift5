import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./helpers/load-ts-module.mjs";
import { candidate, triage } from "./fixtures/scan-replay/factories.mjs";
import { scanWorkflowHarness } from "./helpers/scan-workflow-harness.mjs";

const partials = await loadTsModule("lib/server/partial-results.ts");
const presenter = await loadTsModule("lib/server/presenter.ts", { moduleSources: {
  "lib/server/repository.ts": `export const getEffectiveEntitlement = async () => ({ plan: "free", status: "active" });
    export const getStateRepository = () => ({ kind: "memory" });`,
} });

function scan() {
  return { id: "scan_partial", workspaceId: "ws", websiteUrl: "https://example.com", status: "running",
    progress: [], createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", error: null,
    result: null, runtimeProgress: { partialResultsVersion: 0 }, timing: { acceptedAt: "2026-09-01T00:00:00.000Z",
      firstStartedAt: "2026-09-01T00:00:00.000Z", lastStartedAt: "2026-09-01T00:00:00.000Z", executionId: "fixture" } };
}

function source(id) {
  return { id: `source_${id}`, kind: "reddit", url: `https://reddit.com/${id}`, title: `Thread ${id}`, excerpt: `Excerpt ${id}`,
    capturedAt: "2026-09-01T00:00:00.000Z", synthetic: false, provider: "fixture", sourceMode: "live" };
}

function opportunity(scanId, id) {
  const stableId = partials.stableScanOutputId("opp", scanId, id);
  return { id: stableId, sourceId: `source_${id}`, title: `Opportunity ${id}`, excerpt: `Problem ${id}`, subreddit: "smallbusiness",
    author: `author_${id}`, permalink: `https://reddit.com/${id}`, postedAt: "2026-09-01T00:00:00.000Z", score: 90,
    leadScore: 90, replyScore: 80, competitorScore: 0, researchScore: 70, commentCount: 3, whyItMatters: "Current need",
    intent: "actively-looking", recommendedAction: "reply", communityRisk: "low", competitorSignal: null,
    competitorComplaint: false, customerProblem: "Current workflow pain", replyId: partials.stableScanOutputId("reply", scanId, id),
    synthetic: false, sourceMode: "live", conversationType: "post", authorIdentifier: `author_${id}`,
    potentialCustomerIntent: "high_intent", qualificationScore: 90, firstSeenAt: "2026-09-01T00:00:00.000Z", scanId,
    sourceCreatedAt: "2026-09-01T00:00:00.000Z", supportingSourceIds: [`source_${id}`], supportingSignalCount: 1,
    appearedInPreviousDemandDrop: false, shouldReply: true, mentionProduct: false, disclosureRequired: false };
}

function intelligence(scanId, id) {
  return { id: partials.stableScanOutputId("intel", scanId, id), sourceId: `source_${id}`, externalId: id,
    title: `Research ${id}`, summary: "Useful non-lead evidence", subreddit: "smallbusiness", author: `research_${id}`,
    tags: ["market_insight"], demandSignals: [], competitor: null, sourceCreatedAt: "2026-09-01T00:00:00.000Z",
    sourceIds: [`source_${id}`], competitorScore: 0, researchScore: 70, replyScore: 50 };
}

function reply(record) {
  return { id: record.replyId, opportunityId: record.id, workspaceId: "ws", scanId: record.scanId, content: `Helpful reply for ${record.id}`,
    status: "draft", generation: 1, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    publishedAt: null, publishedUrl: null, publishedVia: null, redditCommentId: null };
}

const access = unlocked => ({ plan: unlocked ? "core" : "free", status: "active", unlocked, verifiedByWebhook: false,
  capabilities: { allExistingFindings: unlocked, allSuggestedReplies: unlocked, sevenDayMonitoring: unlocked,
    continuousMonitoring: unlocked, resultsTracking: unlocked } });

test("preview snapshots are stable, monotonic, deduplicated and tombstone late removals", () => {
  const record = scan();
  const a = candidate("a"), b = candidate("b");
  const judgments = new Map([["a", triage("a")], ["b", triage("b")]]);
  assert.equal(partials.replaceCandidatePreviews(record, [a, b], judgments, "2026-09-01T00:01:00.000Z"), true);
  assert.equal(record.partialResults.version, 1); assert.equal(record.runtimeProgress.partialResultsVersion, 1);
  assert.equal(record.timing.firstResultAt, "2026-09-01T00:01:00.000Z");
  assert.equal(record.timing.firstPreviewAt, "2026-09-01T00:01:00.000Z");
  assert.equal(record.timing.firstQualifiedAt, undefined);
  const firstId = partials.stableScanOutputId("preview", record.id, "a");
  assert.equal(record.partialResults.previews[firstId].qualificationStatus, "pending");
  assert.equal(partials.replaceCandidatePreviews(record, [a, b], judgments), false);
  assert.equal(record.partialResults.version, 1);

  const richer = { ...a, body: `${a.body} Added source detail.` };
  assert.equal(partials.replaceCandidatePreviews(record, [richer], judgments, "2026-09-01T00:02:00.000Z"), true);
  assert.equal(record.partialResults.version, 2);
  assert.equal(record.partialResults.previews[firstId].version, 2, "same candidate keeps its stable card id and gets a newer version");
  assert.ok(record.partialResults.tombstones.some(row => row.id === partials.stableScanOutputId("preview", record.id, "b") && row.version === 2));
});

test("qualified snapshot replaces previews and retries cannot duplicate cards or replies", () => {
  const record = scan(); const row = candidate("a");
  partials.replaceCandidatePreviews(record, [row], new Map([["a", triage("a")]]));
  const opp = opportunity(record.id, "a");
  assert.equal(partials.replaceQualifiedPartialResults(record, { opportunities: [{ externalId: "a", record: opp, source: source("a") }], intelligence: [] }, "2026-09-01T00:03:00.000Z"), true);
  assert.equal(Object.keys(record.partialResults.previews).length, 0);
  assert.equal(Object.keys(record.partialResults.qualified).length, 1);
  assert.equal(record.timing.firstQualifiedAt, "2026-09-01T00:03:00.000Z");
  const version = record.partialResults.version;
  assert.equal(partials.replaceQualifiedPartialResults(record, { opportunities: [{ externalId: "a", record: structuredClone(opp), source: source("a") }], intelligence: [] }), false);
  assert.equal(record.partialResults.version, version);
  assert.equal(partials.publishPartialReply(record, reply(opp)), true);
  assert.equal(partials.publishPartialReply(record, structuredClone(reply(opp))), false);
  assert.equal(Object.keys(record.partialResults.replies).length, 1);
  assert.equal(partials.removePartialRepliesExcept(record, new Set()), true);
  assert.equal(Object.keys(record.partialResults.replies).length, 0);
  assert.ok(record.partialResults.tombstones.some(row => row.id === opp.replyId && row.kind === "reply"));
});

test("partial presenter applies final free/full visibility and strips internal fingerprints", () => {
  const record = scan();
  const opportunities = Array.from({ length: 4 }, (_, index) => opportunity(record.id, `o${index + 1}`));
  const intelligenceRows = Array.from({ length: 4 }, (_, index) => intelligence(record.id, `i${index + 1}`));
  partials.replaceQualifiedPartialResults(record, {
    opportunities: opportunities.map(row => ({ externalId: row.id, record: row, source: source(row.sourceId.replace("source_", "")) })),
    intelligence: intelligenceRows.map(row => ({ externalId: row.externalId, record: row, source: source(row.externalId) })),
  });
  partials.publishPartialReply(record, reply(opportunities[3]));
  const free = presenter.presentPartialResults(record.partialResults, access(false));
  const full = presenter.presentPartialResults(record.partialResults, access(true));
  assert.equal(free.opportunities.length, 3); assert.equal(free.opportunities[0].id, opportunities[3].id);
  assert.equal(free.relevantConversations.length, 3); assert.equal(free.replies.length, 1);
  assert.equal(full.opportunities.length, 4); assert.equal(full.relevantConversations.length, 4);
  assert.ok(!JSON.stringify(free).includes("fingerprint"));
  assert.equal(full.opportunities[0].outputVersion, record.partialResults.qualified[opportunities[0].id].version);
  assert.deepEqual(full.replyStates.map(row => row.state), ["ready"]);
  assert.equal(free.complete, false); assert.equal(free.snapshot, true);
});

test("free partial presentation bounds screened previews and reply states to visible records", () => {
  const previewRecord = scan();
  const rows = Array.from({ length: 4 }, (_, index) => candidate(`preview${index + 1}`));
  partials.replaceCandidatePreviews(previewRecord, rows, new Map(rows.map(row => [row.externalId, triage(row.externalId)])));
  assert.equal(presenter.presentPartialResults(previewRecord.partialResults, access(false)).previews.length, 3);
  assert.equal(presenter.presentPartialResults(previewRecord.partialResults, access(true)).previews.length, 4);

  const qualifiedRecord = scan();
  const opportunities = Array.from({ length: 4 }, (_, index) => opportunity(qualifiedRecord.id, `state${index + 1}`));
  partials.replaceQualifiedPartialResults(qualifiedRecord, { opportunities: opportunities.map(row => ({
    externalId: row.id, record: row, source: source(row.sourceId.replace("source_", "")),
  })), intelligence: [] });
  for (const row of opportunities) partials.publishPartialReply(qualifiedRecord, reply(row), "pending");
  assert.equal(presenter.presentPartialResults(qualifiedRecord.partialResults, access(false)).replyStates.length, 3);
  assert.equal(presenter.presentPartialResults(qualifiedRecord.partialResults, access(true)).replyStates.length, 4);
});

test("real workflow persists screened previews before a terminal downstream failure", { skip: "SCAN_SPEED_KILL_SWITCH permanently disables partialResults; this test exercises the now-retired incremental-publish path through the real workflow" }, async t => {
  const fixture = await scanWorkflowHarness(t, { count: 5, env: { SCAN_PARTIAL_RESULTS: "1" } });
  await assert.rejects(fixture.workflow.runScan(fixture.scan.id), error => error === fixture.stop);
  assert.ok(fixture.scan.partialResults.version > 0);
  assert.ok(fixture.scan.timing.firstPreviewAt);
  assert.equal(Object.keys(fixture.scan.partialResults.previews).length, 5);
  assert.ok(fixture.saved.some(row => Object.keys(row.partialResults?.previews ?? {}).length === 5));
  assert.ok(fixture.saved.some(row => row.timing?.firstPreviewAt));
  assert.ok(Object.values(fixture.scan.partialResults.previews).every(row => row.qualificationStatus === "pending"));
});
