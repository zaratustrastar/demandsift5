import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

/**
 * A scan whose pipeline threw an error must not sit at a terminal-looking
 * "failed" status while a background job attempt is still scheduled to
 * retry it -- that is exactly what stopped the frontend from polling in a
 * real production report. jobWillRetryScanFailure is the one place that
 * decision is made; it must be true only when a job attempt genuinely
 * remains AND the error is a kind retrying can plausibly fix.
 */

const source = await readFile(
  new URL("../lib/server/job-retry-classification.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: "job-retry-classification.ts",
}).outputText;
const { jobWillRetryScanFailure, JOB_LEVEL_TERMINAL_ERROR_CODES } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

test("no job attempt information means the failure is always terminal", () => {
  // Synchronous, non-worker scan requests (e.g. app/api/scans/route.ts's
  // inline fallback path) never pass job attempt info -- a single HTTP
  // request has no later attempt to retry it, so this must not be surfaced
  // as "retrying" with nothing ever actually retrying it.
  assert.equal(jobWillRetryScanFailure({}), false);
  assert.equal(jobWillRetryScanFailure({ code: "reddit_discovery_failed" }), false);
});

test("a retryable code with attempts remaining is retrying, not failed", () => {
  assert.equal(
    jobWillRetryScanFailure({ code: "reddit_discovery_failed", jobAttempts: 1, jobMaxAttempts: 5 }),
    true,
  );
  assert.equal(
    jobWillRetryScanFailure({ code: "scan_execution_failed", jobAttempts: 4, jobMaxAttempts: 5 }),
    true,
  );
  // No code at all (a plain, unclassified Error) is retryable by default,
  // matching the job queue's own isRetryableJobError -- only explicitly
  // terminal codes opt out of retrying.
  assert.equal(jobWillRetryScanFailure({ jobAttempts: 1, jobMaxAttempts: 5 }), true);
});

test("the final allowed attempt is terminal even for an otherwise-retryable code", () => {
  assert.equal(
    jobWillRetryScanFailure({ code: "reddit_discovery_failed", jobAttempts: 5, jobMaxAttempts: 5 }),
    false,
  );
  assert.equal(
    jobWillRetryScanFailure({ code: "reddit_discovery_failed", jobAttempts: 6, jobMaxAttempts: 5 }),
    false,
  );
});

test("terminal error codes never retry, regardless of attempts remaining", () => {
  for (const code of JOB_LEVEL_TERMINAL_ERROR_CODES) {
    assert.equal(
      jobWillRetryScanFailure({ code, jobAttempts: 1, jobMaxAttempts: 5 }),
      false,
      `${code} must stay terminal even with attempts remaining`,
    );
  }
});

test("the terminal set matches what scripts/background-worker.mjs enforces at the job level", async () => {
  // The two lists cannot import a common module (the worker is a standalone
  // script with no build step shared with this app) and are kept in sync by
  // hand -- this pins them together so a change to one that forgets the
  // other fails a test instead of silently drifting.
  const workerSource = await readFile(
    new URL("../scripts/background-worker.mjs", import.meta.url),
    "utf8",
  );
  const match = workerSource.match(/const TERMINAL_SCAN_ERROR_CODES = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(match, "expected scripts/background-worker.mjs to define TERMINAL_SCAN_ERROR_CODES");
  const workerCodes = new Set(
    [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]),
  );
  assert.deepEqual(
    [...JOB_LEVEL_TERMINAL_ERROR_CODES].sort(),
    [...workerCodes].sort(),
  );
});
