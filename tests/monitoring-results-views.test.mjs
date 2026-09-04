import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Both daily Reddit monitoring and weekly AI visibility tracking used to run
 * for real server-side but had no results view at all: the dashboard only
 * ever showed a "last successful check" timestamp, and RedditMonitorRunRecord
 * (which already carries a scanId) and AiVisibilityScanRecord (answers,
 * metrics, provider errors) were fetched by their settings routes and then
 * silently dropped before reaching the UI. These tests pin that both are now
 * actually wired end to end: repository -> API route -> dashboard props ->
 * rendered panel.
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");

const repositorySource = await read("../lib/server/reddit-monitor-repository.ts");
const monitoringRouteSource = await read("../app/api/monitoring/settings/route.ts");
const dashboardSource = await read("../components/demand-intelligence/ProductDashboard.tsx");
const experienceSource = await read("../components/ThreadlineExperience.tsx");
const indexSource = await read("../components/demand-intelligence/index.ts");

test("a real run-history query exists and is exposed by the monitoring settings API", () => {
  assert.match(repositorySource, /export async function listRedditMonitorRuns\(workspaceId: string, seedScanId: string, limit = 10\)/);
  assert.match(monitoringRouteSource, /listRedditMonitorRuns\(actor\.workspaceId, seed\.id, 10\)/);
  // Both GET (initial load) and PUT (after toggling) return the same shape,
  // so flipping the toggle never leaves the run history stale.
  const getIndex = monitoringRouteSource.indexOf("export async function GET");
  const putIndex = monitoringRouteSource.indexOf("export async function PUT");
  assert.match(monitoringRouteSource.slice(getIndex, putIndex), /recentRuns/);
  assert.match(monitoringRouteSource.slice(putIndex), /recentRuns/);
});

test("the Reddit monitoring panel renders recent runs with status, counts, and errors, not just the toggle", () => {
  const start = dashboardSource.indexOf("function RedditMonitoringPanel");
  const end = dashboardSource.indexOf("function AiVisibilityPanel");
  const body = dashboardSource.slice(start, end);
  assert.match(body, /runs\?: RedditMonitorRunSummary\[\] \| null/);
  assert.match(body, /Recent runs/);
  assert.match(body, /run\.fetched/);
  assert.match(body, /run\.normalized/);
  assert.match(body, /run\.unseen/);
  assert.match(body, /run\.relevant/);
  assert.match(body, /run\.opportunities/);
  assert.match(body, /run\.error/);
});

test("a run's own scan can be opened without leaving the dashboard, via a real API fetch, not a dead link", () => {
  const start = dashboardSource.indexOf("function RedditMonitoringPanel");
  const end = dashboardSource.indexOf("function AiVisibilityPanel");
  const body = dashboardSource.slice(start, end);
  assert.match(body, /View results/);
  assert.match(body, /viewRun\(run\.scanId as string\)/);
  assert.match(body, /await onViewRun\(scanId\)/);

  assert.match(experienceSource, /async function viewMonitorRun\(scanId: string\)/);
  const fnStart = experienceSource.indexOf("async function viewMonitorRun");
  const fnBody = experienceSource.slice(fnStart, fnStart + 400);
  // Reuses the same scan-loading path as everything else (refreshScan ->
  // GET /api/scans/{scanId}), not a bespoke fetch that could drift.
  assert.match(fnBody, /refreshScan\(scanId\)/);
  assert.match(experienceSource, /onViewMonitorRun=\{viewMonitorRun\}/);
  assert.match(experienceSource, /monitorRuns=\{monitorRuns\}/);
});

test("the AI visibility panel renders the latest scan's answers, metrics, and any provider errors, not just the toggle", () => {
  const start = dashboardSource.indexOf("function AiVisibilityPanel");
  const end = dashboardSource.indexOf("type IconName");
  const body = dashboardSource.slice(start, end);
  assert.match(body, /scans\?: AiVisibilityScanSummary\[\] \| null/);
  assert.match(body, /Latest results/);
  assert.match(body, /latest\.metrics/);
  assert.match(body, /latest\.providerErrors/);
  assert.match(body, /latest\.answers/);
  assert.match(body, /answer\.brandMentioned/);
  assert.match(body, /answer\.brandRecommended/);
  assert.match(body, /answer\.citations/);
});

test("a provider's failure reason (e.g. an Apify approval link) is rendered as a clickable link, not opaque text", () => {
  assert.match(dashboardSource, /function LinkifiedText/);
  assert.match(dashboardSource, /<LinkifiedText text={message as string} \/>/);
  const start = dashboardSource.indexOf("function AiVisibilityPanel");
  const end = dashboardSource.indexOf("type IconName");
  assert.match(dashboardSource.slice(start, end), /providerErrors\.map\(/);
});

test("ThreadlineExperience actually captures and stores recentRuns/recentScans from both settings fetches, not just the toggle status", () => {
  assert.match(experienceSource, /const \[monitorRuns, setMonitorRuns\] = useState<RedditMonitorRunSummary\[\] \| null>\(null\);/);
  assert.match(experienceSource, /const \[visibilityScans, setVisibilityScans\] = useState<AiVisibilityScanSummary\[\] \| null>\(null\);/);
  assert.match(experienceSource, /setMonitorRuns\(payload\.recentRuns \?\? \[\]\);/);
  assert.match(experienceSource, /setVisibilityScans\(payload\.recentScans \?\? \[\]\);/);
  assert.match(experienceSource, /visibilityScans=\{visibilityScans\}/);
});

test("the new summary types are exported from the demand-intelligence barrel", () => {
  assert.match(indexSource, /RedditMonitorRunSummary/);
  assert.match(indexSource, /AiVisibilityScanSummary/);
  assert.match(indexSource, /AiVisibilityAnswerSummary/);
});
