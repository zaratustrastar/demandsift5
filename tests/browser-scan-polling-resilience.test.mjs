import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const experience = await readFile(
  new URL("../components/ThreadlineExperience.tsx", import.meta.url),
  "utf8",
);

function scanLoopSource() {
  const start = experience.indexOf("async function begin()");
  const end = experience.indexOf("async function refreshScan", start);
  assert.ok(start >= 0 && end > start, "browser scan loop must exist");
  return experience.slice(start, end);
}

test("browser polling mirrors the lightweight acceptance status endpoint at a bounded cadence", () => {
  const loop = scanLoopSource();
  assert.match(loop, /\?statusOnly=1/);
  assert.match(experience, /const SCAN_POLL_INTERVAL_MS = 3_000/);
  assert.match(loop, /window\.setTimeout\(resolve, SCAN_POLL_INTERVAL_MS\)/);
  assert.doesNotMatch(loop, /window\.setTimeout\(resolve, 700\)/);
});

test("transient transport and proxy failures retry instead of immediately replacing the scan with an error screen", () => {
  const loop = scanLoopSource();
  assert.match(experience, /function isTransientPollFailure/);
  assert.match(loop, /transientPollFailures \+= 1/);
  assert.match(loop, /SCAN_POLL_BACKOFF_MAX_MS/);
  assert.match(loop, /if \(!isTransientPollFailure\(pollError\)\) throw pollError/);
  assert.match(loop, /response\.status === 429/);
  assert.match(loop, /response\.status >= 500/);
});

test("completed status is followed by one full report fetch before rendering", () => {
  const loop = scanLoopSource();
  const statusFetch = loop.indexOf("?statusOnly=1");
  const complete = loop.indexOf('latest.scan.status === "complete"');
  const reportFetch = loop.indexOf('fetch(`/api/scans/${created.scan.id}`', complete);
  const reportView = loop.indexOf('setView("report")', reportFetch);
  assert.ok(statusFetch >= 0 && complete > statusFetch && reportFetch > complete && reportView > reportFetch);
});
