import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./helpers/load-ts-module.mjs";
import { scanWorkflowHarness } from "./helpers/scan-workflow-harness.mjs";
const { deepQualificationBudget, discoveryOnlyReview, validateThreadFetchConfiguration } = await loadTsModule("lib/server/scan-depth.ts");
const { resolveScanConfiguration, upgradeScanDepthConfiguration } = await loadTsModule("lib/server/scan-configuration.ts");

test("comment-fetch limit is never used as the deep qualification budget", () => {
  for (const limit of [undefined, "0", "1", "12", "20"]) assert.equal(deepQualificationBudget({ APIFY_REDDIT_ENRICHMENT_LIMIT: limit }), 8);
});
test("explicit depth takes precedence without silently shrinking an existing depth", () => {
  assert.equal(deepQualificationBudget({ REDDIT_ENRICHMENT_BUDGET: "12" }), 12);
  assert.equal(deepQualificationBudget({ REDDIT_DEEP_QUALIFICATION_BUDGET: "20", REDDIT_ENRICHMENT_BUDGET: "12" }), 20);
  assert.throws(() => deepQualificationBudget({ REDDIT_DEEP_QUALIFICATION_BUDGET: "8", REDDIT_ENRICHMENT_BUDGET: "12" }), /cannot silently reduce/);
});
test("invalid Harshmaur fetch settings cannot silently disable verification", () => {
  for (const value of ["abc", "-1", "21", "2.5"]) {
    assert.throws(() => validateThreadFetchConfiguration({ REDDIT_PROVIDER: "harshmaur", APIFY_REDDIT_ENRICHMENT_LIMIT: value }), e => e.code === "scan_configuration_invalid");
  }
  assert.doesNotThrow(() => validateThreadFetchConfiguration({ REDDIT_PROVIDER: "harshmaur", APIFY_REDDIT_ENRICHMENT_LIMIT: "0" }));
});
for (const value of ["0", "-1", "21", "8.5", "abc", "Infinity"]) {
  test(`invalid explicit depth ${value} is a visible configuration error`, () => {
    assert.throws(() => deepQualificationBudget({ REDDIT_DEEP_QUALIFICATION_BUDGET: value }), e => e.code === "scan_configuration_invalid");
    assert.throws(() => deepQualificationBudget({ REDDIT_ENRICHMENT_BUDGET: value }), e => e.code === "scan_configuration_invalid");
  });
}
test("T01 receipts get an explicit depth correction using saved settings only", () => {
  for (const [legacy, expected] of [[undefined, 8], ["12", 12]]) {
    const old = resolveScanConfiguration({ APIFY_REDDIT_ENRICHMENT_LIMIT: "0", REDDIT_ENRICHMENT_BUDGET: legacy });
    old.defaultsVersion = "deployed-cb24c44-v1";
    delete old.environment.REDDIT_DEEP_QUALIFICATION_BUDGET;
    const id = old.id;
    const upgraded = upgradeScanDepthConfiguration(old);
    assert.equal(upgraded.environment.REDDIT_DEEP_QUALIFICATION_BUDGET, String(expected));
    assert.equal(upgraded.migratedFromId, id); assert.notEqual(upgraded.id, id);
    assert.equal(old.defaultsVersion, "deployed-cb24c44-v1", "migration must not mutate the old receipt");
    assert.equal(upgradeScanDepthConfiguration(upgraded), upgraded);
  }
});

for (const [label, options, expected] of [
  ["fetch off", {}, 8],
  ["legacy explicit twelve", { env: { REDDIT_ENRICHMENT_BUDGET: "12" } }, 12],
  ["new explicit twelve", { env: { REDDIT_DEEP_QUALIFICATION_BUDGET: "12" } }, 12],
  ["only three eligible", { count: 3 }, 3],
  ["fetch cap smaller than review target", { fetchLimit: 2, dropUnfetched: true }, 8],
  ["all thread fetches fail", { fetchLimit: 8, failFetch: true }, 8],
  ["zero-result independent audit", { worthReviewing: false }, 8],
]) {
  test(`actual workflow retains intended deep coverage: ${label}`, async t => {
    const fixture = await scanWorkflowHarness(t, options);
    await assert.rejects(fixture.workflow.runScan(fixture.scan.id), e => e === fixture.stop);
    assert.equal(fixture.submissions.length, 1);
    const rows = fixture.submissions[0].conversations;
    assert.equal(rows.length, expected);
    assert.equal(new Set(rows.map(row => row.externalId)).size, expected);
    assert.ok(rows.every(row => fixture.rows.some(original => original.externalId === row.externalId)));
    if (!options.fetchLimit || options.failFetch) assert.ok(rows.every(row => row.provenance.metadata.enriched !== true));
    const stage = fixture.scan.progress.find(row => row.id === "enrichment");
    if (!options.fetchLimit) assert.match(stage.detail, /fetching is disabled; 0 additional threads verified/);
    if (options.failFetch) assert.match(stage.detail, /will not present a definitive zero/);
    const accepted = fixture.saved.find(row => row.runConfiguration);
    assert.ok(accepted.progress.every(stage => stage.status === "pending"));
    assert.ok(fixture.logs.some(row => row.name === "qualifyConversations" && row.event === "start"));
  });
}

test("invalid depth fails before either provider does work", async t => {
  const fixture = await scanWorkflowHarness(t, { env: { REDDIT_DEEP_QUALIFICATION_BUDGET: "0" } });
  fixture.state.reddit.discover = async () => assert.fail("must not start discovery");
  await assert.rejects(fixture.workflow.runScan(fixture.scan.id), e => e.code === "scan_configuration_invalid");
  assert.equal(fixture.scan.status, "failed"); assert.equal(fixture.submissions.length, 0);
});

test("discovery-only fallback never invents thread context or mutates source evidence", async t => {
  const fixture = await scanWorkflowHarness(t, { count: 1 });
  const original = fixture.rows[0]; const snapshot = structuredClone(original);
  const result = discoveryOnlyReview(original);
  assert.equal(result.body, original.body); assert.equal(result.structuredContext.matched.body, original.body);
  assert.deepEqual(result.structuredContext.replies, []); assert.equal(result.provenance.metadata.enriched, false);
  assert.deepEqual(original, snapshot);
});
