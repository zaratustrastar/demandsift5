import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repository = await readFile(new URL("../lib/server/repository.ts", import.meta.url), "utf8");
const latestRoute = await readFile(new URL("../app/api/scans/latest/route.ts", import.meta.url), "utf8");
const experience = await readFile(new URL("../components/ThreadlineExperience.tsx", import.meta.url), "utf8");

test("workspace restoration considers the newest scan regardless of completion status", () => {
  assert.match(repository, /getLatestWorkspaceScan\(workspaceId: string\)/);
  assert.match(latestRoute, /getLatestWorkspaceScan\(actor\.workspaceId\)/);
  assert.doesNotMatch(latestRoute, /getLatestScan\(actor\.workspaceId\)/);
});

test("a failed latest scan is surfaced instead of silently showing an older completed report", () => {
  const restore = experience.indexOf("async function restoreLatestWorkspace");
  const failed = experience.indexOf('latest.scan.status === "failed"', restore);
  const report = experience.indexOf('latest.scan.status === "complete" && latest.report', restore);
  assert.ok(restore >= 0 && failed > restore && report > failed);
  assert.match(experience, /setErrorMessage\(latest\.scan\.error/);
});

test("production navigation no longer links to temporary acceptance diagnostics", () => {
  assert.doesNotMatch(experience, /acceptance-ai-diagnostics/);
});
