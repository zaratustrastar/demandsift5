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
const { jobWillRetryScanFailure, JOB_LEVEL_TERMINAL_ERROR_CODES, scanPipelineErrorCode } = await import(
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


test("empty structured chat exhaustion is classified terminal", () => {
  const code = scanPipelineErrorCode({
    name: "OpenAiProviderError",
    message: "OpenAI returned no structured chat response text (finish_reason=stop, content_type=null, output_tokens=508).",
  });
  assert.equal(code, "openai_structured_output_failed");
  assert.equal(jobWillRetryScanFailure({ code, jobAttempts: 1, jobMaxAttempts: 5 }), false);
});

test("ordinary transient failures remain unclassified and retryable", () => {
  const code = scanPipelineErrorCode(new Error("temporary upstream timeout"));
  assert.equal(code, undefined);
  assert.equal(jobWillRetryScanFailure({ code, jobAttempts: 1, jobMaxAttempts: 5 }), true);
});

test("Reddit enrichment exhaustion remains terminal", () => {
  const code = scanPipelineErrorCode(
    new Error("Reddit enrichment failed: selected 1, enriched 0, failed 1."),
  );
  assert.equal(code, "reddit_enrichment_failed");
  assert.equal(jobWillRetryScanFailure({ code, jobAttempts: 1, jobMaxAttempts: 5 }), false);
});

// Real production incident: a site returning a persistent 403 kept a
// worker slot occupied for ~30 minutes across repeated queue-level
// retries, each re-running the full crawl, because nothing distinguished
// "the site is actively refusing this" from an ordinary transient
// failure. These pin the fix: PermanentWebsiteFetchError's own .code is
// recognized directly by scanPipelineErrorCode (not by fragile message
// matching) and lands in the terminal set, while ordinary transient
// crawl failures (429, 5xx, network errors -- still a plain Error) stay
// exactly as retryable as before.
test("a persistent 403/401/404/410/451 from the crawler is classified terminal, not retried", () => {
  for (const status of [401, 403, 404, 410, 451]) {
    const error = { name: "PermanentWebsiteFetchError", code: "website_permanently_unreachable", status, message: `Website returned HTTP ${status}.` };
    const code = scanPipelineErrorCode(error);
    assert.equal(code, "website_permanently_unreachable", `status ${status} should classify as terminal`);
    assert.equal(jobWillRetryScanFailure({ code, jobAttempts: 1, jobMaxAttempts: 5 }), false, `status ${status} should not retry`);
  }
});

test("website_permanently_unreachable is in the terminal set (and stays in sync with the worker script's copy, per the test above)", () => {
  assert.ok(JOB_LEVEL_TERMINAL_ERROR_CODES.has("website_permanently_unreachable"));
});

test("a repeated 429 or 5xx from the crawler remains retryable, unlike a permanent status", () => {
  for (const status of [429, 500, 502, 503]) {
    const error = new Error(`Website returned HTTP ${status}.`);
    const code = scanPipelineErrorCode(error);
    assert.equal(code, undefined, `status ${status} should not be classified terminal`);
    assert.equal(jobWillRetryScanFailure({ code, jobAttempts: 1, jobMaxAttempts: 5 }), true, `status ${status} should still retry`);
  }
});

test("a temporary network error (timeout, DNS, connection reset) during crawling remains retryable", () => {
  for (const message of ["fetch failed: ETIMEDOUT", "getaddrinfo ENOTFOUND example.com", "socket hang up"]) {
    const code = scanPipelineErrorCode(new Error(message));
    assert.equal(code, undefined);
    assert.equal(jobWillRetryScanFailure({ code, jobAttempts: 1, jobMaxAttempts: 5 }), true);
  }
});
