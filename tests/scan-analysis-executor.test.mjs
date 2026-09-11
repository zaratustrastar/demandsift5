import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { loadTsModule } from "./helpers/load-ts-module.mjs";

test("analysis executor uses its durable completion marker and never restarts during the approved scan", async t => {
  const key = `executorFixture_${randomUUID().replaceAll("-", "")}`;
  const secret = "fixture-only-local-worker-secret-000000";
  const previous = process.env.BACKGROUND_WORKER_SECRET;
  process.env.BACKGROUND_WORKER_SECRET = secret;
  t.after(() => { delete globalThis[key]; if (previous === undefined) delete process.env.BACKGROUND_WORKER_SECRET; else process.env.BACKGROUND_WORKER_SECRET = previous; });
  const calls = [];
  const job = { id: randomUUID(), type: "scan.analyze", attempts: 1, maxAttempts: 5, status: "running", lockedBy: "fixture-worker", payload: { scanId: "scan_fixture", workspaceId: "workspace_fixture" } };
  const scan = { id: "scan_fixture", workspaceId: "workspace_fixture", status: "queued", phase: "scan_queued", analysisCompletedAt: new Date().toISOString(), discoveryProfile: { profileStage: "full" } };
  globalThis[key] = { repository: { kind: "postgres", getJob: async () => job, getScan: async () => scan }, runScan: async (...args) => { calls.push(args); } };
  const ref = `globalThis[${JSON.stringify(key)}]`;
  const route = await loadTsModule("app/api/internal/jobs/[jobId]/execute/route.ts", { moduleSources: {
    "lib/server/repository.ts": `export const getStateRepository = () => ${ref}.repository;`,
    "lib/server/scan-workflow.ts": `export const runScan = (...args) => ${ref}.runScan(...args);`,
    "lib/server/reddit-monitor-workflow.ts": "export async function runRedditMonitorScan() {}",
    "lib/server/reddit-monitor-repository.ts": "export async function getClaimedRedditMonitorJob() { return null; } export async function getRedditMonitorRun() { return null; }",
    "lib/server/ai-visibility-workflow.ts": "export async function runAiVisibilityScan() {}",
    "lib/server/ai-visibility-repository.ts": "export async function getAiVisibilityScan() { return null; } export async function getClaimedAiVisibilityJob() { return null; }",
  } });
  const post = attempt => route.POST(new Request(`http://localhost/api/internal/jobs/${job.id}/execute`, {
    method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify({ workerId: "fixture-worker", attempt }),
  }), { params: { jobId: job.id } });
  assert.equal((await post(0)).status, 409);
  assert.equal((await (await post(1)).json()).complete, true);
  scan.status = "failed"; scan.error = "Later full scan failed";
  assert.equal((await (await post(1)).json()).complete, true);
  assert.equal(calls.length, 0);
  delete scan.analysisCompletedAt; scan.status = "running"; scan.phase = "analyzing";
  const midway = await post(1);
  assert.equal(midway.status, 202); assert.equal((await midway.json()).complete, false);
  assert.equal(calls.length, 1); assert.equal(calls[0][1].stopAfterUnderstanding, true);
  assert.equal(calls[0][1].jobAttempts, 1); assert.equal(calls[0][1].jobWorkerId, "fixture-worker");
});
