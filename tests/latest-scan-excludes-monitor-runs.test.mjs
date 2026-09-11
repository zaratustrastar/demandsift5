import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * getLatestWorkspaceScan (used by GET /api/scans/latest, which the report
 * page calls on every load/refresh with no scan_id in the URL -- see
 * restoreLatestWorkspace in ThreadlineExperience.tsx) used to pick the
 * most-recently-created scan for a workspace with no distinction between
 * the user's primary Market Scan and a daily Reddit monitor's own scoped
 * scan (scanKind "monitoring", see monitoringScan() in
 * reddit-monitor-workflow.ts). A monitor check creates a real ScanRecord
 * even when it finds 0 relevant matches that day, so once a monitor run
 * became the newest scan, refreshing the report page would silently swap
 * the displayed results to that (possibly empty) monitor run, with no way
 * back to the primary scan.
 *
 * These are conceptually different things: the primary scan searches
 * roughly a year of Reddit broadly (per user confirmation), a monitor run
 * only checks the day's fixed watch terms. "Latest scan" must stay pinned
 * to the primary scan; a monitor run stays reachable only through its own
 * explicit "View results" action (viewMonitorRun), which fetches it by id
 * directly, never through this "latest" lookup.
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");
const repositorySource = await read("../lib/server/repository.ts");

function latestScanImplementations() {
  const matches = [];
  let searchFrom = 0;
  for (;;) {
    const start = repositorySource.indexOf("async getLatestWorkspaceScan(workspaceId: string) {", searchFrom);
    if (start === -1) break;
    const end = repositorySource.indexOf("\n  }\n", start);
    matches.push(repositorySource.slice(start, end));
    searchFrom = end;
  }
  return matches;
}

test("getLatestWorkspaceScan is implemented twice (memory-store and Postgres), and both are found", () => {
  const implementations = latestScanImplementations();
  assert.equal(implementations.length, 2, "expected exactly one memory-store and one Postgres implementation");
});

test("the memory-store implementation excludes scanKind 'monitoring' scans", () => {
  const [memoryImpl] = latestScanImplementations();
  assert.match(memoryImpl, /scan\.workspaceId === workspaceId && scan\.scanKind !== "monitoring"/);
});

test("the Postgres implementation excludes scanKind 'monitoring' scans via a JSONB comparison that correctly treats a missing scanKind as not-monitoring", () => {
  const [, postgresImpl] = latestScanImplementations();
  assert.match(postgresImpl, /runtimeScans\.record.*->>\s*'scanKind'.*IS DISTINCT FROM 'monitoring'/s);
  assert.match(postgresImpl, /eq\(runtimeScans\.workspaceId, workspaceId\)/);
});

test("primary/discovery scans are never explicitly tagged, so the filter must not require scanKind to be present", () => {
  // scanKind is optional ("discovery" | "monitoring" | undefined) on
  // ScanRecord -- only monitoringScan() ever sets it. A filter that
  // required scanKind === "discovery" would incorrectly exclude every
  // primary scan created before this field existed, or any primary scan
  // that simply never sets it (which is all of them today).
  assert.doesNotMatch(repositorySource, /scan\.scanKind === "discovery"/);
  assert.doesNotMatch(repositorySource, /scanKind\.\s*=\s*'discovery'/);
});

test("monitor-run scans remain reachable through their own explicit view action, not through the latest-scan lookup", async () => {
  const experience = await read("../components/ThreadlineExperience.tsx");
  assert.match(experience, /async function viewMonitorRun\(scanId: string\)/);
  const viewFnStart = experience.indexOf("async function viewMonitorRun");
  const viewFnBody = experience.slice(viewFnStart, experience.indexOf("\n  }\n", viewFnStart));
  assert.match(viewFnBody, /await refreshScan\(scanId\);/);
  // refreshScan fetches the given scan by id directly (GET /api/scans/{id}),
  // never through /api/scans/latest.
  assert.match(experience, /await fetch\(`\/api\/scans\/\$\{scanId\}`, \{ cache: "no-store" \}\);/);
});
