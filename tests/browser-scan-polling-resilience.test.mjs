import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const experience = await readFile(
  new URL("../components/ThreadlineExperience.tsx", import.meta.url),
  "utf8",
);
const polling = await readFile(new URL("../lib/client/scan-polling.ts", import.meta.url), "utf8");

function scanLoopSource() {
  const start = experience.indexOf("async function begin()");
  const end = experience.indexOf("async function refreshScan", start);
  assert.ok(start >= 0 && end > start, "browser scan loop must exist");
  return experience.slice(start, end);
}

test("browser polling mirrors the lightweight acceptance status endpoint at a bounded cadence", () => {
  const loop = scanLoopSource();
  assert.match(loop, /\?statusOnly=1/);
  assert.match(polling, /const SCAN_POLL_INTERVAL_MS = 3_000/);
  assert.match(loop, /startScanPolling\(/);
  assert.match(polling, /HIDDEN_SCAN_POLL_INTERVAL_MS = 30_000/);
  assert.doesNotMatch(loop, /window\.setTimeout\(resolve, 700\)/);
});

test("transient transport and proxy failures retry instead of immediately replacing the scan with an error screen", () => {
  const loop = scanLoopSource();
  assert.match(polling, /function isTransientPollFailure/);
  assert.match(polling, /failures \+= 1/);
  assert.match(polling, /SCAN_POLL_BACKOFF_MAX_MS/);
  assert.match(loop, /onConnectionChange: setScanConnected/);
  assert.match(polling, /response\.status === 429/);
  assert.match(polling, /response\.status >= 500/);
});

test("completed status is followed by one full report fetch before rendering the account-aware results view", () => {
  const loop = scanLoopSource();
  const statusFetch = loop.indexOf("?statusOnly=1");
  const complete = loop.indexOf('latest.scan.status === "complete"');
  const reportFetch = loop.indexOf('`/api/scans/${accepted.scan.id}`', complete);
  const reportView = loop.indexOf('setView(accountRef.current ? "report" : "results")', reportFetch);
  assert.ok(statusFetch >= 0 && complete > statusFetch && reportFetch > complete && reportView > reportFetch);
});

test("waiting UI has no invented percentage/time promise and restoration cannot overwrite a new submission", () => {
  assert.doesNotMatch(experience, /stageBarFill|const pct|Usually done in under half a minute|usually a minute or two|first scan takes about two minutes/);
  assert.match(experience, /navigationVersion !== navigationVersionRef\.current/);
  assert.match(experience, /scan\?\.durable/);
  assert.match(experience, /Connection interrupted\. Showing the last saved status/);
});
