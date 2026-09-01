import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Daily Reddit monitoring and AI visibility tracking both finish
 * asynchronously in the background (a Postgres-backed scheduler, see
 * scripts/background-worker.mjs), on a timescale of minutes. Previously,
 * the report view fetched /api/monitoring/settings and
 * /api/ai-visibility/settings exactly once whenever `view`/`accessLevel`
 * changed, with no repeating refetch -- so a run that finished while the
 * tab was already open (e.g. the user watching it complete) never showed
 * up; the only way to see it was a manual page reload. These tests pin
 * that a bounded-interval refetch now exists for both panels, and that it
 * is deliberately much slower than the main scan's SCAN_POLL_INTERVAL_MS
 * (these two change at most once every 15 minutes-to-a-week, not
 * multiple times a second).
 */

const experience = await readFile(
  new URL("../components/ThreadlineExperience.tsx", import.meta.url),
  "utf8",
);

function loadingEffectSource() {
  const start = experience.indexOf("async function loadRedditConnection()");
  const end = experience.indexOf("}, [view, accessLevel]);", start);
  assert.ok(start >= 0 && end > start, "the monitoring/visibility loading effect must exist");
  return experience.slice(start, end);
}

test("a dedicated, slower poll interval is defined for the background-scheduled panels", async () => {
  assert.match(experience, /const BACKGROUND_STATUS_POLL_INTERVAL_MS = 20_000;/);
  // Must be slower than the main scan's poll -- these panels don't need
  // sub-second responsiveness.
  const polling = await readFile(new URL("../lib/client/scan-polling.ts", import.meta.url), "utf8");
  assert.match(polling, /const SCAN_POLL_INTERVAL_MS = 3_000;/);
});

test("loadRedditMonitoring and loadAiVisibility are re-invoked on a repeating interval, not just once on mount", () => {
  const body = loadingEffectSource();
  assert.match(body, /window\.setInterval\(\(\) => \{\s*void loadRedditMonitoring\(\);\s*void loadAiVisibility\(\);\s*\}, BACKGROUND_STATUS_POLL_INTERVAL_MS\)/);
});

test("the interval is cleared on cleanup, so it does not keep polling after the view/access level changes or the component unmounts", () => {
  const body = loadingEffectSource();
  assert.match(body, /window\.clearInterval\(backgroundStatusTimer\)/);
});

test("Reddit OAuth connection status is deliberately excluded from the repeating poll -- it only changes in response to a user action on this page", () => {
  const body = loadingEffectSource();
  const intervalStart = body.indexOf("window.setInterval");
  const intervalEnd = body.indexOf(");", body.indexOf("BACKGROUND_STATUS_POLL_INTERVAL_MS", intervalStart));
  const intervalBody = body.slice(intervalStart, intervalEnd);
  assert.equal(intervalBody.includes("loadRedditConnection"), false);
});
