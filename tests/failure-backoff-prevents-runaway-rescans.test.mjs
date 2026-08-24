import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Bug: a scan/run that fails inside its own workflow (runAiVisibilityScan,
 * runRedditMonitorScan) was marked "failed" without ever advancing the
 * workspace's next_run_at watermark -- only the success path
 * (completeAiVisibilityScan, completeRedditMonitorRun) did that. Job-level
 * retries are a no-op once the scan/run's own status is "failed" (see
 * claimedVisibilitySnapshot / claimedMonitorSnapshot in
 * app/api/internal/jobs/[jobId]/execute/route.ts, which only re-invoke
 * their ensure*Execution helper while status is neither "succeeded" nor
 * "failed"). So once a background_jobs row for that scan/run exhausted its
 * attempts and went terminal, the *scheduler's own poll* -- seeing
 * next_run_at still stuck at whatever "now" the enabling toggle or prior
 * cycle set -- would enqueue an entirely new scan/run from scratch on its
 * very next tick. Observed in production: 3 full, independently successful
 * ChatGPT/Gemini/Perplexity Actor trios firing ~5-10 minutes apart for one
 * workspace, because the OpenAI classification step downstream of the
 * (successful, paid) Actor calls kept failing and nothing pushed the
 * watermark forward in between.
 *
 * Fix: failAiVisibilityScan and failRedditMonitorRun now also push
 * next_run_at forward by a bounded delay (30 min / 15 min respectively) --
 * long enough that the scheduler poll can't immediately re-enqueue a fresh,
 * paid run on its next tick, short enough that a real transient failure
 * still recovers the same day rather than waiting for the full
 * week/24h success interval.
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");
const visibilityRepo = await read("../lib/server/ai-visibility-repository.ts");
const monitorRepo = await read("../lib/server/reddit-monitor-repository.ts");
const executeRoute = await read("../app/api/internal/jobs/[jobId]/execute/route.ts");

function functionBody(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `could not find ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `could not find ${endMarker} after ${startMarker}`);
  return source.slice(start, end);
}

test("job-level retries are confirmed to be a no-op once status is 'failed' -- this is why the scheduler-level fix is required", () => {
  assert.match(
    executeRoute,
    /if \(start && scan\.status !== "succeeded" && scan\.status !== "failed"\) \{\s*void ensureVisibilityExecution/,
  );
  assert.match(
    executeRoute,
    /if \(start && run\.status !== "succeeded" && run\.status !== "failed"\) \{\s*void ensureMonitorExecution/,
  );
});

test("failAiVisibilityScan advances next_run_at by a bounded delay, not just marking the scan failed", () => {
  const body = functionBody(
    visibilityRepo,
    "export async function failAiVisibilityScan",
    "\n}\n",
  );
  assert.match(body, /const nextRunAt = new Date\(failedAt\.getTime\(\) \+ FAILURE_RETRY_DELAY_MS\);/);
  assert.match(body, /\.update\(runtimeAiVisibilitySchedules\)/);
  assert.match(body, /\.set\(\{ nextRunAt, updatedAt: failedAt \}\)/);
  // Memory-store dev/test path must get the same watermark advance, not
  // just the Postgres path.
  assert.match(body, /nextRunAt: nextRunAt\.toISOString\(\),/);
});

test("failRedditMonitorRun advances next_run_at by a bounded delay, not just marking the run failed", () => {
  const body = functionBody(
    monitorRepo,
    "export async function failRedditMonitorRun",
    "\n}\n",
  );
  assert.match(body, /const nextRunAt = new Date\(failedAt\.getTime\(\) \+ FAILURE_RETRY_DELAY_MS\);/);
  assert.match(body, /\.update\(runtimeRedditMonitors\)/);
  assert.match(body, /\.set\(\{ nextRunAt, updatedAt: failedAt \}\)/);
  assert.match(body, /nextRunAt: nextRunAt\.toISOString\(\),/);
});

test("the failure backoff is strictly shorter than the success interval for both features, so failures recover sooner than the next scheduled run would anyway", () => {
  const visibilityDelayMatch = visibilityRepo.match(/const FAILURE_RETRY_DELAY_MS = (\d+) \* (\d+) \* (\d+)_?(\d+)?;/);
  assert.ok(visibilityDelayMatch, "FAILURE_RETRY_DELAY_MS constant not found in ai-visibility-repository.ts");
  const visibilityDelayMs = 30 * 60 * 1_000;
  assert.match(visibilityRepo, /const FAILURE_RETRY_DELAY_MS = 30 \* 60 \* 1_000;/);
  assert.ok(visibilityDelayMs < 7 * 24 * 60 * 60 * 1_000, "must be well under the weekly success interval");

  assert.match(monitorRepo, /const FAILURE_RETRY_DELAY_MS = 15 \* 60 \* 1_000;/);
  const monitorDelayMs = 15 * 60 * 1_000;
  assert.ok(monitorDelayMs < 24 * 60 * 60 * 1_000, "must be well under the daily success interval");
});

test("failure never touches the success-only watermark fields (lastSuccessfulScanAt / lastSuccessfulMonitorAt)", () => {
  const visibilityBody = functionBody(
    visibilityRepo,
    "export async function failAiVisibilityScan",
    "\n}\n",
  );
  assert.equal(visibilityBody.includes("lastSuccessfulScanAt"), false);
  assert.equal(visibilityBody.includes("lastScanId"), false);

  const monitorBody = functionBody(
    monitorRepo,
    "export async function failRedditMonitorRun",
    "\n}\n",
  );
  assert.equal(monitorBody.includes("lastSuccessfulMonitorAt"), false);
  assert.equal(monitorBody.includes("lastRunId"), false);
});
