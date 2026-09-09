import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Prompt 9A: lightweight subreddit include/exclude control for ongoing
 * Reddit monitoring. Automatic discovery stays the default; this is an
 * advanced control layered on top of it, not a new search architecture.
 * No schema migration -- watch_terms is already a jsonb column, and
 * "subreddit" is just a new value in RedditWatchTermKind's existing
 * union. No new ranking/relevance algorithm -- "Recommended" is a
 * straight aggregation of subreddits already present in the seed scan's
 * own opportunity/intelligence results.
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");
const contracts = await read("../lib/server/contracts.ts");
const repository = await read("../lib/server/reddit-monitor-repository.ts");
const workflow = await read("../lib/server/reddit-monitor-workflow.ts");
const route = await read("../app/api/monitoring/settings/route.ts");
const dashboard = await read("../components/demand-intelligence/ProductDashboard.tsx");
const experience = await read("../components/ThreadlineExperience.tsx");
const actorInputSource = await read("../lib/providers/reddit-monitor.server.ts");

function fnBody(source, name, endMarker) {
  const start = source.indexOf(name);
  assert.ok(start > -1, `${name} not found`);
  const end = endMarker ? source.indexOf(endMarker, start + name.length) : source.indexOf("\n}\n", start);
  return source.slice(start, end);
}

test("RedditWatchTermKind gained 'subreddit' as a fourth value -- no new type, no schema migration needed since watch_terms is already a jsonb column", () => {
  assert.match(contracts, /export type RedditWatchTermKind = "brand" \| "competitor" \| "keyword" \| "subreddit";/);
});

test("recommendedSubreddits aggregates from both the seed scan and ongoing monitoring's own recent-run scans -- not a new score, not new storage", () => {
  const body = fnBody(repository, "export async function recommendedSubreddits");
  assert.match(body, /collectFrom\(scan\.result\)/);
  assert.match(body, /if \(!run\.scanId\) continue;/);
  assert.match(body, /const runScan = await repository\.getScan\(run\.scanId\);/);
  assert.match(body, /if \(runScan\) collectFrom\(runScan\.result\);/);
  assert.equal(/score|rank|weight/i.test(body), false);
});

test("recommendedSubreddits takes recentRuns as a parameter rather than re-fetching it -- the settings route already fetches this same list, and re-fetching would be a wasteful duplicate query", () => {
  const body = fnBody(repository, "export async function recommendedSubreddits");
  assert.match(body, /recentRuns: RedditMonitorRunRecord\[\]/);
  assert.equal(body.includes("listRedditMonitorRuns("), false);
});

test("both route handlers pass their own already-fetched recentRuns into recommendedSubreddits instead of triggering a second query", () => {
  const matches = route.match(/recommendedSubreddits\(seed, recentRuns\)/g) ?? [];
  assert.equal(matches.length, 2);
});

test("subreddit-kind watch terms are excluded from the search terms sent to fetchRedditMonitorCandidates (never sent to Apify as keywords)", () => {
  const body = fnBody(workflow, "export async function runRedditMonitorScan", "\nexport ");
  assert.match(body, /term\.active && term\.kind !== "subreddit"/);
});

test("excluded subreddits are filtered after the fetch and before ingestion, not by scoping the search itself", () => {
  const body = fnBody(workflow, "export async function runRedditMonitorScan", "\nexport ");
  assert.match(body, /const excludedSubreddits = new Set\(/);
  assert.match(body, /term\.kind === "subreddit" && !term\.active/);
  assert.match(body, /const filteredCandidates = excludedSubreddits\.size === 0/);
  assert.match(body, /candidates: filteredCandidates,/);
  const fetchIndex = body.indexOf("fetchRedditMonitorCandidates(");
  const filterIndex = body.indexOf("const filteredCandidates");
  const ingestIndex = body.indexOf("ingestRedditMonitorMatches(");
  assert.ok(fetchIndex < filterIndex && filterIndex < ingestIndex);
});

test("the Apify actor input itself was not touched -- no new scraping logic, no subreddit field added to the actor input type", () => {
  assert.equal(/subreddit/i.test(actorInputSource), false);
});

test("the settings route's parseWatchTerms accepts 'subreddit' as a real kind instead of silently coercing it to 'keyword'", () => {
  const body = fnBody(route, "function parseWatchTerms");
  assert.match(body, /object\.kind === "subreddit"/);
});

test("the dedupe key in the UI's save logic includes kind, not just value -- a competitor and an identically-named subreddit must not collide", () => {
  const body = fnBody(dashboard, "const parsedTerms = ()", "\n  };");
  assert.match(body, /const key = `\$\{term\.kind\}:\$\{term\.value\.toLocaleLowerCase\("en-US"\)\}`;/);
});

test("the Subreddits section shows Recommended vs Added manually, and Included/Excluded, derived from existing data -- no fake relevance score, no analytics", () => {
  const body = fnBody(dashboard, "function RedditMonitoringPanel", "\nfunction ");
  assert.match(body, /row\.source === "recommended" \? "Recommended" : "Added manually"/);
  assert.match(body, /row\.active \? "Included" : "Excluded"/);
  // Checked against the JSX return block specifically, not the whole
  // function body -- explanatory comments elsewhere in this function
  // correctly say things like "not a new relevance score", which would
  // otherwise be a false positive for this exact check.
  const jsxBody = body.slice(body.indexOf("return ("));
  assert.equal(/relevance score|conversation count|average score|citation count|chart/i.test(jsxBody), false);
});

test("manually-added subreddits can be removed", () => {
  const body = fnBody(dashboard, "function RedditMonitoringPanel", "\nfunction ");
  assert.match(body, /row\.source === "manual" && \(/);
});

test("the UI copy does not promise proactive subreddit-specific searching -- it's explicit that adding a subreddit only stops filtering it out of the existing search", () => {
  const body = fnBody(dashboard, "function RedditMonitoringPanel", "\nfunction ");
  assert.match(body, /doesn&rsquo;t start a new search there/);
  assert.match(body, /allows its results through when they already match your watch terms/);
});

test("automatic discovery stays the default -- the Subreddits section intro copy matches what was specified", () => {
  const body = fnBody(dashboard, "function RedditMonitoringPanel", "\nfunction ");
  assert.match(body, /Scooptr automatically monitors relevant communities\. You can exclude any that are not useful or add one manually\./);
});

test("recommendedSubreddits flows end to end: fetched in ThreadlineExperience.tsx from both the GET and PUT responses, and passed down to ProductDashboard", () => {
  assert.match(experience, /const \[recommendedSubreddits, setRecommendedSubreddits\] = useState<string\[\] \| null>\(null\);/);
  const matches = experience.match(/setRecommendedSubreddits\(payload\.recommendedSubreddits \?\? \[\]\);/g) ?? [];
  assert.equal(matches.length, 2);
  assert.match(experience, /recommendedSubreddits=\{recommendedSubreddits\}/);
});

test("recommendedSubredditNames is threaded through both RedditMonitoringPanel call sites in ProductDashboard.tsx", () => {
  const matches = dashboard.match(/recommendedSubredditNames=\{recommendedSubreddits\}/g) ?? [];
  assert.equal(matches.length, 2);
});
