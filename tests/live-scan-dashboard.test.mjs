import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const experience = await readFile(new URL("../components/ThreadlineExperience.tsx", import.meta.url), "utf8");
const presenter = await readFile(new URL("../lib/server/presenter.ts", import.meta.url), "utf8");

function scanLoop() {
  const start = experience.indexOf('useEffect(() => {\n    if (view !== "scanning") return;');
  const end = experience.indexOf("async function refreshScan", start);
  assert.ok(start >= 0 && end > start);
  return experience.slice(start, end);
}

test("running scans render a live result shell instead of manufacturing a final report", () => {
  assert.match(experience, /if \(view === "scanning"\)[\s\S]*?<LiveScanDashboard/);
  assert.match(experience, /These are interim counts, not the final scan totals/);
  assert.match(experience, /Conversations being checked/);
  assert.match(experience, /Qualification pending/);
  assert.match(experience, /Useful evidence, not a lead/);
  assert.doesNotMatch(scanLoop(), /scanResponseToDashboard/);
});

test("status version gates partial requests and late responses cannot replace newer state", () => {
  const loop = scanLoop();
  assert.match(loop, /advertisedVersion <= partialVersionRef\.current/);
  assert.match(loop, /partial\?afterVersion=\$\{partialVersionRef\.current\}/);
  assert.match(loop, /payload\.version > partialVersionRef\.current/);
  assert.match(loop, /mergeLivePartialState\(current, payload\.partial!\)/);
});

test("reply state is public but safe, and edited live drafts survive final report conversion", () => {
  assert.match(presenter, /replyStates: Object\.values\(store\.replies\)/);
  assert.match(presenter, /safeErrorCode/);
  assert.match(experience, /preserveLiveReplyEdits\(complete, liveReplyEdits\)/);
  assert.match(experience, /Reply being prepared/);
  assert.match(experience, /Reply needs another attempt/);
});

test("a failed scan with saved partials remains in the usable live view", () => {
  const loop = scanLoop();
  assert.match(loop, /if \(hasPartial\)[\s\S]*?return true/);
  assert.match(experience, /Coverage is incomplete, so these findings are not presented as a definitive final report/);
});
