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

// SCAN_SPEED_KILL_SWITCH (lib/server/scan-configuration.ts) forces every flag
// in ROLLOUTS to false, full stop -- no env var, rollout percentage, internal
// workspace allowlist or production default can override it. The tests below
// still exercise the underlying rollout *mechanism* (bucket assignment,
// percentage validation, internal-workspace detection, per-scan freezing)
// through `rollout.*`, since that plumbing is untouched and still correct;
// they no longer assert that mechanism ever flips `flags.*` to true, because
// with the kill switch on, it provably never does.

test("workspace rollout assignment and configuration identity are deterministic", () => {
  const first = cohort(25, "workspace-stable");
  const second = cohort(25, "workspace-stable");
  assert.equal(first.rollout.workspaceBucket, second.rollout.workspaceBucket);
  assert.equal(first.flags.compactTriage, second.flags.compactTriage);
  assert.equal(first.id, second.id);
});

test("percentage cohorts are still nested and reach all workspaces only at 100 percent, even though the kill switch keeps every flag off", () => {
  const ids = Array.from({ length: 1_000 }, (_, index) => `workspace-${index}`);
  const bucketedIn = rolloutPercent => new Set(ids.filter(id => {
    const config = cohort(rolloutPercent, id);
    // The kill switch means the flag itself never turns on...
    assert.equal(config.flags.compactTriage, false);
    // ...but the underlying cohort math it would otherwise gate is still
    // exactly as selective as before, so re-enabling the switch later
    // resumes a rollout in progress rather than restarting from zero.
    return config.rollout.workspaceBucket !== null && config.rollout.workspaceBucket < config.rollout.percentages.compactTriage;
  }));
  const five = bucketedIn(5), twentyFive = bucketedIn(25), all = bucketedIn(100);
  assert.ok(five.size > 0 && five.size < twentyFive.size);
  assert.ok(twentyFive.size < all.size);
  assert.equal(all.size, ids.length);
  assert.ok([...five].every(id => twentyFive.has(id)));
  assert.ok([...twentyFive].every(id => all.has(id)));
});

test("an internal workspace is still detected, but the kill switch beats even that bypass", () => {
  const context = { workspaceId: "workspace-internal" };
  const wouldHaveBeenEnabled = resolveScanConfiguration({ [flag]: "1", [percent]: "0",
    SCAN_SPEED_INTERNAL_WORKSPACES: "workspace-other, workspace-internal" }, context);
  assert.equal(wouldHaveBeenEnabled.rollout.internalWorkspace, true);
  assert.equal(wouldHaveBeenEnabled.flags.compactTriage, false);

  const killed = resolveScanConfiguration({ [flag]: "0", [percent]: "100",
    SCAN_SPEED_INTERNAL_WORKSPACES: "workspace-internal" }, context);
  assert.equal(killed.flags.compactTriage, false);
});

test("accepted receipts persist resolved (off) behavior rather than mutable rollout controls", () => {
  const workspaceId = "workspace-pinned";
  const accepted = cohort(100, workspaceId);
  assert.equal(accepted.flags.compactTriage, false);
  assert.equal(accepted.environment[flag], null);
  assert.equal(accepted.environment[percent], undefined);
  assert.ok(!JSON.stringify(accepted).includes("workspace-pinned"));

  const resumed = environmentForScan(accepted, { [flag]: "1", [percent]: "0" });
  assert.equal(resumed[flag], undefined);

  const rejected = cohort(0, workspaceId);
  assert.equal(rejected.flags.compactTriage, false);
  assert.equal(environmentForScan(rejected, { [flag]: "1", [percent]: "100" })[flag], undefined);
});

test("every guarded behavior resolves to off, regardless of independently-configured rollout percentages", () => {
  const config = resolveScanConfiguration({
    SCAN_COORDINATED_RETRIES: "1", SCAN_COORDINATED_RETRIES_ROLLOUT_PERCENT: "100",
    SCAN_OVERLAP_DISCOVERY_TRIAGE: "1", SCAN_OVERLAP_DISCOVERY_TRIAGE_ROLLOUT_PERCENT: "100",
    SCAN_COMPACT_TRIAGE: "1", SCAN_COMPACT_TRIAGE_ROLLOUT_PERCENT: "100",
    SCAN_PARTIAL_RESULTS: "1", SCAN_PARTIAL_RESULTS_ROLLOUT_PERCENT: "100",
  }, { workspaceId: "workspace-independent" });
  assert.equal(config.environment.SCAN_COORDINATED_RETRIES, null);
  assert.equal(config.flags.overlapDiscoveryTriage, false);
  assert.equal(config.flags.compactTriage, false);
  assert.equal(config.flags.partialResults, false);
});

test("production no longer enables overlap or progressive results by default -- the kill switch overrides PRODUCTION_DEFAULT_FLAGS too", () => {
  const config = resolveScanConfiguration({ APP_RUNTIME_ENV: "production" }, {
    workspaceId: "workspace-production-defaults",
  });
  assert.equal(config.flags.overlapDiscoveryTriage, false);
  assert.equal(config.flags.partialResults, false);
  assert.equal(config.flags.compactTriage, false);
  assert.equal(config.environment.SCAN_OVERLAP_DISCOVERY_TRIAGE, null);
  assert.equal(config.environment.SCAN_PARTIAL_RESULTS, null);

  // The strongest possible case for turning them on -- explicit flag=1,
  // 100% rollout, internal workspace, production runtime, all at once --
  // must still lose to the kill switch.
  const strongestCase = resolveScanConfiguration({
    APP_RUNTIME_ENV: "production",
    SCAN_OVERLAP_DISCOVERY_TRIAGE: "1", SCAN_OVERLAP_DISCOVERY_TRIAGE_ROLLOUT_PERCENT: "100",
    SCAN_PARTIAL_RESULTS: "1", SCAN_PARTIAL_RESULTS_ROLLOUT_PERCENT: "100",
    SCAN_SPEED_INTERNAL_WORKSPACES: "workspace-production-defaults",
  }, { workspaceId: "workspace-production-defaults" });
  assert.equal(strongestCase.flags.overlapDiscoveryTriage, false);
  assert.equal(strongestCase.flags.partialResults, false);
});

test("invalid rollout percentages fail visibly", () => {
  for (const value of ["-1", "101", "5.5", "not-a-number"]) {
    assert.throws(() => cohort(value, "workspace-invalid"), error =>
      error.code === "scan_configuration_invalid" && /integer from 0 to 100/.test(error.message));
  }
});

test("the real workflow resolves its workspace before freezing rollout behavior, and the kill switch still wins", async t => {
  const fixture = await scanWorkflowHarness(t, { count: 1, env: { [flag]: "1", [percent]: "0",
    SCAN_SPEED_INTERNAL_WORKSPACES: "fixture_workspace" } });
  await assert.rejects(fixture.workflow.runScan(fixture.scan.id), error => error === fixture.stop);
  assert.equal(fixture.scan.runConfiguration.rollout.internalWorkspace, true);
  assert.equal(fixture.scan.runConfiguration.flags.compactTriage, false);
  assert.ok(!JSON.stringify(fixture.scan.runConfiguration).includes("fixture_workspace"));
});
