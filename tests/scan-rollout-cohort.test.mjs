import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./helpers/load-ts-module.mjs";
import { scanWorkflowHarness } from "./helpers/scan-workflow-harness.mjs";

const { environmentForScan, resolveScanConfiguration } = await loadTsModule("lib/server/scan-configuration.ts");

const flag = "SCAN_COMPACT_TRIAGE";
const percent = "SCAN_COMPACT_TRIAGE_ROLLOUT_PERCENT";

function cohort(rolloutPercent, workspaceId, extra = {}) {
  return resolveScanConfiguration({ [flag]: "1", [percent]: String(rolloutPercent), ...extra }, { workspaceId });
}

test("workspace rollout assignment and configuration identity are deterministic", () => {
  const first = cohort(25, "workspace-stable");
  const second = cohort(25, "workspace-stable");
  assert.equal(first.rollout.workspaceBucket, second.rollout.workspaceBucket);
  assert.equal(first.flags.compactTriage, second.flags.compactTriage);
  assert.equal(first.id, second.id);
});

test("percentage cohorts are nested and reach all workspaces only at 100 percent", () => {
  const ids = Array.from({ length: 1_000 }, (_, index) => `workspace-${index}`);
  const selected = rolloutPercent => new Set(ids.filter(id => cohort(rolloutPercent, id).flags.compactTriage));
  const five = selected(5), twentyFive = selected(25), all = selected(100);
  assert.ok(five.size > 0 && five.size < twentyFive.size);
  assert.ok(twentyFive.size < all.size);
  assert.equal(all.size, ids.length);
  assert.ok([...five].every(id => twentyFive.has(id)));
  assert.ok([...twentyFive].every(id => all.has(id)));
});

test("an internal workspace bypasses percentage selection but never the base kill switch", () => {
  const context = { workspaceId: "workspace-internal" };
  const enabled = resolveScanConfiguration({ [flag]: "1", [percent]: "0",
    SCAN_SPEED_INTERNAL_WORKSPACES: "workspace-other, workspace-internal" }, context);
  assert.equal(enabled.rollout.internalWorkspace, true);
  assert.equal(enabled.flags.compactTriage, true);

  const killed = resolveScanConfiguration({ [flag]: "0", [percent]: "100",
    SCAN_SPEED_INTERNAL_WORKSPACES: "workspace-internal" }, context);
  assert.equal(killed.flags.compactTriage, false);
});

test("accepted receipts persist resolved behavior rather than mutable rollout controls", () => {
  const workspaceId = "workspace-pinned";
  const accepted = cohort(100, workspaceId);
  assert.equal(accepted.flags.compactTriage, true);
  assert.equal(accepted.environment[flag], "1");
  assert.equal(accepted.environment[percent], undefined);
  assert.ok(!JSON.stringify(accepted).includes("workspace-pinned"));

  const resumed = environmentForScan(accepted, { [flag]: "1", [percent]: "0" });
  assert.equal(resumed[flag], "1");
  assert.equal(resumed[percent], "0");

  const rejected = cohort(0, workspaceId);
  assert.equal(rejected.flags.compactTriage, false);
  assert.equal(environmentForScan(rejected, { [flag]: "1", [percent]: "100" })[flag], undefined);
});

test("each guarded behavior resolves independently from the same stable workspace bucket", () => {
  const config = resolveScanConfiguration({
    SCAN_COORDINATED_RETRIES: "1", SCAN_COORDINATED_RETRIES_ROLLOUT_PERCENT: "100",
    SCAN_OVERLAP_DISCOVERY_TRIAGE: "1", SCAN_OVERLAP_DISCOVERY_TRIAGE_ROLLOUT_PERCENT: "0",
    SCAN_COMPACT_TRIAGE: "1", SCAN_COMPACT_TRIAGE_ROLLOUT_PERCENT: "100",
    SCAN_PARTIAL_RESULTS: "1", SCAN_PARTIAL_RESULTS_ROLLOUT_PERCENT: "0",
  }, { workspaceId: "workspace-independent" });
  assert.equal(config.environment.SCAN_COORDINATED_RETRIES, "1");
  assert.equal(config.flags.overlapDiscoveryTriage, false);
  assert.equal(config.flags.compactTriage, true);
  assert.equal(config.flags.partialResults, false);
});

test("invalid rollout percentages fail visibly", () => {
  for (const value of ["-1", "101", "5.5", "not-a-number"]) {
    assert.throws(() => cohort(value, "workspace-invalid"), error =>
      error.code === "scan_configuration_invalid" && /integer from 0 to 100/.test(error.message));
  }
});

test("the real workflow resolves its workspace before freezing rollout behavior", async t => {
  const fixture = await scanWorkflowHarness(t, { count: 1, env: { [flag]: "1", [percent]: "0",
    SCAN_SPEED_INTERNAL_WORKSPACES: "fixture_workspace" } });
  await assert.rejects(fixture.workflow.runScan(fixture.scan.id), error => error === fixture.stop);
  assert.equal(fixture.scan.runConfiguration.rollout.internalWorkspace, true);
  assert.equal(fixture.scan.runConfiguration.flags.compactTriage, true);
  assert.ok(!JSON.stringify(fixture.scan.runConfiguration).includes("fixture_workspace"));
});
