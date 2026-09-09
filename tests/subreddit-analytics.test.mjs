import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Prompt 9B: read-only "Subreddit performance" analytics, separate from
 * Prompt 9A's Monitoring config controls. No new scraping, no new
 * ranking algorithm, no new DB tables/schema -- everything here
 * aggregates fields that already exist on OpportunityRecord,
 * MarketIntelligenceRecord, and AiVisibilityAnswer.
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");
const analytics = await read("../lib/server/subreddit-analytics.ts");
const citationParser = await read("../lib/server/ai-visibility-analysis.ts");
const route = await read("../app/api/analytics/subreddits/route.ts");
const dashboard = await read("../components/demand-intelligence/ProductDashboard.tsx");
const experience = await read("../components/ThreadlineExperience.tsx");
const navTypes = await read("../components/demand-intelligence/types.ts");
const demoData = await read("../components/demand-intelligence/demo-data.ts");
const barrel = await read("../components/demand-intelligence/index.ts");
const schema = await read("../db/postgres/schema.ts");

function fnBody(source, name, endMarker) {
  const start = source.indexOf(name);
  assert.ok(start > -1, `${name} not found`);
  const end = endMarker ? source.indexOf(endMarker, start + name.length) : source.indexOf("\n}\n", start);
  return source.slice(start, end);
}

test("subredditFromCitationUrl extracts the subreddit from a standard reddit.com path, and returns null for anything else", () => {
  const body = fnBody(citationParser, "export function subredditFromCitationUrl");
  assert.match(body, /if \(!isRedditCitation\(citation\)\) return null;/);
  assert.match(body, /\/\\\/r\\\/\(\[a-zA-Z0-9_\]\+\)\\b\/i/);
});

test("no redirect resolution or new network request was added for redd.it short links -- the parser is pure string matching", () => {
  const body = fnBody(citationParser, "export function subredditFromCitationUrl");
  assert.equal(/fetch\(|await /.test(body), false);
});

test("relevant conversations are deduplicated by sourceId, the field both OpportunityRecord and MarketIntelligenceRecord share", () => {
  const body = fnBody(analytics, "export function aggregateSubredditPerformance", "\n}\n");
  assert.match(body, /conversations\.get\(sourceId\)/);
  assert.match(body, /if \(existing\?\.isOpportunity\) return;/);
});

test("opportunities and market intelligence are both collected into the same per-subreddit map, from both the seed scan and recent monitoring-run scans", () => {
  const body = fnBody(analytics, "export function aggregateSubredditPerformance", "\n}\n");
  assert.match(body, /result\.opportunities/);
  assert.match(body, /result\.marketIntelligence/);
  assert.match(body, /collectFromResult\(input\.seedScan\.result\);/);
  assert.match(body, /for \(const runScan of input\.recentRunScans\) collectFromResult\(runScan\.result\);/);
});

test("avg relevance is computed from researchScore on both record types -- never from score/leadScore", () => {
  const body = fnBody(analytics, "export function aggregateSubredditPerformance", "\n}\n");
  assert.match(body, /researchScore: opportunity\.researchScore/);
  assert.match(body, /researchScore: intelligence\.researchScore/);
  assert.equal(/\.leadScore\b/.test(body), false);
  assert.equal(/\bopportunity\.score\b/.test(body), false);
});

test("avgRelevance is null, never a fabricated number, when there is nothing to average", () => {
  const body = fnBody(analytics, "export function aggregateSubredditPerformance", "\n}\n");
  assert.match(body, /const avgRelevance = scores\.length > 0[\s\S]{0,120}: null;/);
});

test("citation-only subreddits (zero relevant conversations) are included in the output, not excluded", () => {
  const body = fnBody(analytics, "export function aggregateSubredditPerformance", "\n}\n");
  assert.match(body, /const allSubreddits = new Set\(\[\.\.\.bySubreddit\.keys\(\), \.\.\.citationCounts\.keys\(\)\]\);/);
});

test("a citation-only row's latest falls back to the citing answer's fetchedAt, never fabricated, never the conversation date it doesn't have", () => {
  const body = fnBody(analytics, "export function aggregateSubredditPerformance", "\n}\n");
  assert.match(body, /const latest = conversationLatest \?\? citationLatest\.get\(subreddit\) \?\? null;/);
});

test("AI cited reuses the already-computed AiVisibilityAnswer.redditCitations field rather than re-filtering citations itself", () => {
  const body = fnBody(analytics, "export function aggregateSubredditPerformance", "\n}\n");
  assert.match(body, /for \(const citation of answer\.redditCitations\)/);
});

test("the analytics route is read-only (GET only) and reuses the same recent-run bound already established in Prompt 9A", () => {
  assert.equal(/export async function (PUT|POST|DELETE)/.test(route), false);
  assert.match(route, /const RECENT_RUN_LIMIT = 10;/);
});

test("the route only reads the latest succeeded AI Visibility scan, not full history", () => {
  const body = fnBody(route, "export async function GET");
  assert.match(body, /visibilityScans\.find\(\(scan\) => scan\.status === "succeeded"\)/);
});

test("the route fetches recent monitoring-run scans the same way Prompt 9A's recommendedSubreddits already does -- via each run's own linked scanId", () => {
  const body = fnBody(route, "export async function GET");
  assert.match(body, /listRedditMonitorRuns\(actor\.workspaceId, seedScan\.id, RECENT_RUN_LIMIT\)/);
  assert.match(body, /repository\.getScan\(run\.scanId as string\)/);
});

test("no new database table was added for this feature", () => {
  const newTableCount = (schema.match(/pgTable\("subreddit/gi) ?? []).length;
  assert.equal(newTableCount, 0);
});

test("default sort is opportunities desc, then relevant conversations desc, then avg relevance desc -- a citation-only row falls out naturally, not via a special case", () => {
  const body = fnBody(dashboard, "function defaultSubredditSort");
  assert.match(body, /if \(b\.opportunities !== a\.opportunities\) return b\.opportunities - a\.opportunities;/);
  assert.match(body, /if \(b\.relevantConversations !== a\.relevantConversations\) return b\.relevantConversations - a\.relevantConversations;/);
  assert.match(body, /const aScore = a\.avgRelevance \?\? -1;/);
});

test("the table shows an em dash, not a fabricated number, for avg relevance and latest when they don't exist", () => {
  const body = fnBody(dashboard, "function SubredditPerformanceTable", "\n}\n");
  assert.match(body, /row\.avgRelevance === null \? "\\u2014" : row\.avgRelevance/);
  assert.match(body, /row\.latest \? relativeTime\(row\.latest\) : "\\u2014"/);
});

test("the table reuses the existing .answerTable style -- no new table CSS class was introduced", () => {
  const body = fnBody(dashboard, "function SubredditPerformanceTable", "\n}\n");
  assert.match(body, /styles\.answerTable/);
});

test("the scope note matches exactly what was specified", () => {
  const body = fnBody(dashboard, "function SubredditPerformanceTable", "\n}\n");
  assert.match(body, /Based on the initial scan and recent monitoring activity\./);
});

test("no chart library or chart component is used anywhere in the analytics table", () => {
  const body = fnBody(dashboard, "function SubredditPerformanceTable", "\n}\n");
  assert.equal(/recharts|chart\.js|<svg|d3\./i.test(body), false);
});

test("'analytics' is a real navigation section, added alongside the existing sections, not replacing monitoring", () => {
  assert.match(navTypes, /\| "monitoring"\s*\n\s*\| "analytics"/);
  assert.match(demoData, /\{ id: "monitoring", label: "Monitoring config" \},\s*\n\s*\{ id: "analytics", label: "Analytics" \},/);
});

test("the Analytics section renders SubredditPerformanceTable under its own activeSection branch, separate from monitoring's own branch", () => {
  const analyticsSection = dashboard.slice(dashboard.indexOf('activeSection === "analytics"'));
  assert.match(analyticsSection.slice(0, 300), /<SubredditPerformanceTable data=\{subredditPerformance\} \/>/);
});

test("ThreadlineExperience.tsx fetches /api/analytics/subreddits and passes the result down to ProductDashboard", () => {
  assert.match(experience, /fetch\(`\/api\/analytics\/subreddits\?scanId=\$\{encodeURIComponent\(activeScanId\)\}`, \{ cache: "no-store" \}\)/);
  assert.match(experience, /subredditPerformance=\{subredditPerformance\}/);
});

test("the new types are re-exported from the barrel file so ThreadlineExperience.tsx can import them", () => {
  assert.match(barrel, /SubredditPerformanceRow,\s*\n\s*SubredditPerformanceSummary,/);
});
