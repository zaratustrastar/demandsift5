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
const css = await read("../components/demand-intelligence/ProductDashboard.module.css");

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
  const body = fnBody(analytics, "export function collectSubredditConversations", "\n}\n");
  assert.match(body, /conversations\.get\(sourceId\)/);
  assert.match(body, /if \(existing\?\.isOpportunity\) return;/);
});

test("opportunities and market intelligence are both collected into the same per-subreddit map, from both the seed scan and recent monitoring-run scans, via the shared collectSubredditConversations helper", () => {
  const body = fnBody(analytics, "export function collectSubredditConversations", "\n}\n");
  assert.match(body, /result\.opportunities/);
  assert.match(body, /result\.marketIntelligence/);
  assert.match(body, /collectFromResult\(seedScan\.result\);/);
  assert.match(body, /for \(const runScan of recentRunScans\) collectFromResult\(runScan\.result\);/);
});

test("avg relevance is computed from researchScore on both record types -- never from score/leadScore", () => {
  const body = fnBody(analytics, "export function collectSubredditConversations", "\n}\n");
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
  const body = fnBody(analytics, "function collectCitations", "\n}\n");
  assert.match(body, /for \(const citation of answer\.redditCitations\)/);
});

test("summarizeSubredditAnalytics is a pure function over already-computed rows -- no new data collection, and avg relevance is a count-weighted recombination, not an average of averages", () => {
  const body = fnBody(analytics, "export function summarizeSubredditAnalytics");
  assert.match(body, /rows\.reduce\(\(sum, row\) => sum \+ row\.relevantConversations, 0\)/);
  assert.match(body, /rows\.reduce\(\(sum, row\) => sum \+ row\.opportunities, 0\)/);
  assert.match(body, /row\.avgRelevance \* row\.relevantConversations/);
  assert.equal(/fetch\(|await /.test(body), false);
});

test("summarizeSubredditAnalytics has no trend/delta field -- no historical comparison data exists to support one", () => {
  const body = fnBody(analytics, "export type SubredditAnalyticsSummary", "\n};");
  assert.equal(/trend|delta|percent|change|previous/i.test(body), false);
});

test("computeDemandMix groups the real top 4 subreddits plus a real Other bucket -- no artificial category names are invented", () => {
  const body = fnBody(analytics, "export function computeDemandMix");
  assert.match(body, /topSubredditsByConversations\(rows, 4\)/);
  assert.match(body, /label: "Other"/);
  assert.equal(/Productivity|Career|Management/i.test(body), false);
});

test("computeDemandMix percentages are derived from real counts via division, not hardcoded", () => {
  const body = fnBody(analytics, "export function computeDemandMix");
  assert.match(body, /percent: Math\.round\(\(row\.relevantConversations \/ total\) \* 100\)/);
});

test("selectBestOpportunitySource returns null (not a fabricated pick) when nothing has any opportunities, and never computes a comparison statement", () => {
  const body = fnBody(analytics, "export function selectBestOpportunitySource");
  assert.match(body, /if \(candidates\.length === 0\) return null;/);
  assert.equal(/2x|better|comparison/i.test(body), false);
});

test("selectTopAiCitedCommunities only includes subreddits with a real, positive citation count", () => {
  const body = fnBody(analytics, "export function selectTopAiCitedCommunities");
  assert.match(body, /\.filter\(\(row\) => row\.aiCited > 0\)/);
});

test("the activity timeline groups by real calendar date from each conversation's own postedAt/sourceCreatedAt -- no gap-filling, no fabricated dates", () => {
  const body = fnBody(analytics, "export function aggregateSubredditActivityTimeline");
  assert.match(body, /conversation\.postedAt\.slice\(0, 10\)/);
  assert.match(body, /if \(!date \|\| Number\.isNaN\(Date\.parse\(conversation\.postedAt\)\)\) continue;/);
  assert.equal(/for \(let i = 0; i <.*days|fillGap|eachDay/i.test(body), false);
});

test("the activity timeline groups subreddits outside the given top set into a real 'other' count, not a fabricated series", () => {
  const body = fnBody(analytics, "export function aggregateSubredditActivityTimeline");
  assert.match(body, /if \(topSet\.has\(subreddit\)\) \{/);
  assert.match(body, /point\.other \+= 1;/);
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
  assert.match(body, /row\.avgRelevance === null \? \(\s*<span className=\{styles\.subredditMuted\}>\{"\\u2014"\}<\/span>/);
  assert.match(body, /row\.latest \? relativeTime\(row\.latest\) : <span className=\{styles\.subredditMuted\}>\{"\\u2014"\}<\/span>/);
});

test("the table is a CSS Grid data list, not an HTML <table> -- header and rows are separate grid containers sharing one grid-template-columns definition, applied via the exact same .subredditTopGrid class, so no column can drift between header and body", () => {
  const body = fnBody(dashboard, "function SubredditPerformanceTable", "\n}\n");
  assert.equal(/styles\.answerTable/.test(body), false);
  // Checked against the JSX return block with its own {/* ... */} JSX
  // comments stripped out -- one of those comments correctly mentions
  // "<table>" while describing what this moved away from, which would
  // otherwise be a false positive for this exact check.
  const jsxBody = body.slice(body.indexOf("return (")).replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  assert.equal(/<table/i.test(jsxBody), false);
  const headMatches = body.match(/className=\{`\$\{styles\.subredditTopGrid\} \$\{styles\.subredditTopGridHead\}`\}/g) ?? [];
  const rowMatches = body.match(/className=\{styles\.subredditTopGrid\} role="row"/g) ?? [];
  assert.equal(headMatches.length, 1);
  assert.equal(rowMatches.length, 1);
});

test("the scope note matches exactly what was specified", () => {
  const body = fnBody(dashboard, "function SubredditPerformanceTable", "\n}\n");
  assert.match(body, /Based on the initial scan and recent monitoring activity\./);
});

test("no chart library or chart-style SVG (bars, arcs, paths for data) is used in this table -- the header uses the real supplied Reddit logo image asset, not an SVG glyph", () => {
  const body = fnBody(dashboard, "function SubredditPerformanceTable", "\n}\n");
  assert.equal(/recharts|chart\.js|d3\.|<svg/i.test(body), false);
  assert.match(body, /src="\/logos\/reddit-mark\.png"/);
  assert.match(body, /className=\{styles\.subredditTopIcon\}/);
});

test("'analytics' is a real navigation section, added alongside the existing sections, not replacing monitoring", () => {
  assert.match(navTypes, /\| "monitoring"\s*\n\s*\| "analytics"/);
  assert.match(demoData, /\{ id: "monitoring", label: "Monitoring config" \},\s*\n\s*\{ id: "analytics", label: "Analytics" \},/);
});

test("the Analytics section renders SubredditPerformanceTable under its own activeSection branch, separate from monitoring's own branch", () => {
  const analyticsSection = dashboard.slice(dashboard.indexOf('activeSection === "analytics"'), dashboard.indexOf('activeSection === "settings"'));
  assert.match(analyticsSection, /<SubredditPerformanceTable data=\{subredditPerformance\} \/>/);
});

test("ThreadlineExperience.tsx fetches /api/analytics/subreddits and passes the result down to ProductDashboard", () => {
  assert.match(experience, /fetch\(`\/api\/analytics\/subreddits\?scanId=\$\{encodeURIComponent\(activeScanId\)\}`, \{ cache: "no-store" \}\)/);
  assert.match(experience, /subredditPerformance=\{subredditPerformance\}/);
});

test("the new types are re-exported from the barrel file so ThreadlineExperience.tsx can import them", () => {
  assert.match(barrel, /SubredditPerformanceRow,\s*\n\s*SubredditPerformanceSummary,/);
});

// ---- Prompt 10B: the redesigned Analytics screen's infographics ----

test("no third-party chart library was added anywhere in the codebase -- the new charts are hand-rolled SVG", async () => {
  assert.equal(/from "recharts"|from "chart\.js"|from "d3"|from "victory"|from "@nivo|from "@visx/i.test(dashboard), false);
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const chartDeps = Object.keys(deps).filter((name) => /chart|recharts|d3|victory|nivo|visx/i.test(name));
  assert.deepEqual(chartDeps, []);
});

test("AnalyticsKpiRow renders exactly the four specified KPIs from the pure summary object, with no trend/delta shown -- only a shared muted context label", () => {
  const body = fnBody(dashboard, "function AnalyticsKpiRow", "\n}\n");
  assert.match(body, /label: "Relevant conversations", value: summary\.relevantConversations/);
  assert.match(body, /label: "Opportunities", value: summary\.opportunities/);
  assert.match(body, /label: "Avg relevance", value: summary\.avgRelevance === null \? "\\u2014" : summary\.avgRelevance/);
  assert.match(body, /label: "AI-cited communities", value: summary\.aiCitedCommunities/);
  assert.match(body, /Recent monitoring activity/);
  assert.equal(/[+-]\d+%|vs\. previous|vs previous/i.test(body), false);
});

test("SubredditActivityChart renders one bar per real activity point with a truthful empty state, and shows no fabricated data when there is nothing to chart", () => {
  const body = fnBody(dashboard, "function SubredditActivityChart", "\n}\n");
  assert.match(body, /points\.length === 0/);
  assert.match(body, /Not enough dated activity yet to chart\./);
  assert.match(body, /points\.map\(\(point, index\)/);
});

test("SubredditActivityChart's own SVG is capped so it never renders wider than its native viewBox scale on desktop, keeping label text legible instead of oversized", () => {
  const cssBody = css.slice(css.indexOf(".analyticsActivitySvg"), css.indexOf(".analyticsActivitySvg") + 200);
  assert.match(cssBody, /max-width: 560px;/);
});

test("SubredditActivityChart's axis label font size is large enough to stay legible when the SVG scales down on a narrow mobile container", () => {
  const body = fnBody(dashboard, "function SubredditActivityChart", "\n}\n");
  const match = body.match(/fontSize="(\d+)" fill="#8b93a1"/);
  assert.ok(match, "axis label fontSize not found");
  assert.ok(Number(match[1]) >= 12, `axis label fontSize ${match[1]} is too small to survive mobile scaling`);
});

test("SubredditActivityChart's legend can wrap and does not force a fixed single-line width", () => {
  const cssBody = css.slice(css.indexOf(".analyticsChartLegend {"), css.indexOf(".analyticsChartLegend {") + 200);
  assert.match(cssBody, /flex-wrap: wrap;/);
});

test("DemandMixDonut renders a real donut from computeDemandMix's own slices, with a truthful empty state and no fabricated category names", () => {
  const body = fnBody(dashboard, "function DemandMixDonut", "\n}\n");
  assert.match(body, /data\.demandMix/);
  assert.match(body, /No relevant conversations yet to chart\./);
  assert.equal(/Productivity|Career|Management/i.test(body), false);
});

test("DemandMixDonut's center label shows the real total and 'conversations', matching the specified center-of-donut format", () => {
  const body = fnBody(dashboard, "function DemandMixDonut", "\n}\n");
  assert.match(body, /\{total\}<\/text>/);
  assert.match(body, />conversations<\/text>/);
});

test("BestOpportunitySourceCard selects from data.bestOpportunitySource and shows a truthful empty state rather than a fabricated pick, with no unsupported comparison statement", () => {
  const body = fnBody(dashboard, "function BestOpportunitySourceCard", "\n}\n");
  assert.match(body, /const best = data\.bestOpportunitySource;/);
  assert.match(body, /No opportunities found yet in any monitored community\./);
  assert.equal(/2x|more opportunities than average/i.test(body), false);
});

test("AiCitedCommunitiesCard renders compact pills from data.aiCitedCommunities with a truthful empty state", () => {
  const body = fnBody(dashboard, "function AiCitedCommunitiesCard", "\n}\n");
  assert.match(body, /data\.aiCitedCommunities/);
  assert.match(body, /styles\.analyticsPill/);
  assert.match(body, /No AI Visibility citations attributable to a subreddit yet\./);
});

test("the Top subreddits table still renders with its existing loading/empty states, sourceId-deduplicated rows, and mobile scroll wrapper unchanged", () => {
  const body = fnBody(dashboard, "function SubredditPerformanceTable", "\n}\n");
  assert.match(body, /<h2>Top subreddits<\/h2>/);
  assert.match(body, /Communities producing the most relevant conversations and opportunities\./);
  assert.match(body, /styles\.subredditTableScroll/);
  assert.match(body, /styles\.aiVisibilityLoading/);
  assert.match(body, /No subreddit activity yet/);
});

test("the Analytics section renders the KPI row, the two charts, the two insight cards, and the table together, in that order", () => {
  const section = dashboard.slice(dashboard.indexOf('activeSection === "analytics"'), dashboard.indexOf('activeSection === "settings"'));
  const kpiIndex = section.indexOf("<AnalyticsKpiRow");
  const chartIndex = section.indexOf("<SubredditActivityChart");
  const donutIndex = section.indexOf("<DemandMixDonut");
  const bestIndex = section.indexOf("<BestOpportunitySourceCard");
  const aiIndex = section.indexOf("<AiCitedCommunitiesCard");
  const tableIndex = section.indexOf("<SubredditPerformanceTable");
  assert.ok(kpiIndex > -1 && chartIndex > kpiIndex && donutIndex > chartIndex && bestIndex > donutIndex && aiIndex > bestIndex && tableIndex > aiIndex);
});

test("the two insight cards sit in a two-column grid so they stretch to a balanced, matching height by default", () => {
  const cssBody = css.slice(css.indexOf(".analyticsInsightsRow {"), css.indexOf(".analyticsInsightsRow {") + 200);
  assert.match(cssBody, /grid-template-columns: 1fr 1fr;/);
});

test("the KPI row, charts row, and insight cards row all collapse to fewer columns on mobile", () => {
  const mobileBlock = css.slice(css.indexOf(".analyticsKpiRow { grid-template-columns: repeat(2, 1fr); }") - 40, css.indexOf(".analyticsKpiRow { grid-template-columns: repeat(2, 1fr); }") + 250);
  assert.match(mobileBlock, /\.analyticsChartsRow \{ grid-template-columns: 1fr; \}/);
  assert.match(mobileBlock, /\.analyticsInsightsRow \{ grid-template-columns: 1fr; \}/);
});

// ---- Top subreddits table: premium presentation upgrade ----

test("the table's outer card now has its own padding class paired with .card, matching every sibling analytics card above it -- previously it used bare .card with no padding at all", () => {
  assert.match(dashboard, /className=\{`\$\{styles\.card\} \$\{styles\.subredditTopCard\}`\}/);
  const cssBody = css.slice(css.indexOf(".subredditTopCard {"), css.indexOf(".subredditTopCard {") + 100);
  assert.match(cssBody, /padding:/);
});

test("sort logic, column definitions, and data flow into the table are completely unchanged by this visual pass", () => {
  const body = fnBody(dashboard, "function SubredditPerformanceTable", "\n}\n");
  assert.match(body, /sortSubredditRows\(data\?\.rows \?\? \[\], sortColumn, sortDirection\)/);
  assert.match(body, /\[\.\.\.\(data\?\.rows \?\? \[\]\)\]\.sort\(defaultSubredditSort\)/);
  assert.match(body, /SUBREDDIT_COLUMNS\.map\(\(column\)/);
});

test("no new metrics, fake trends, or comparison values were introduced in this visual pass", () => {
  const body = fnBody(dashboard, "function SubredditPerformanceTable", "\n}\n");
  assert.equal(/[+-]\d+%|vs\. previous|vs previous|2x|better than average/i.test(body), false);
});

test("the header is a clean title/subtitle group; the scope note was demoted out of the header entirely into a footer note below the table", () => {
  const body = fnBody(dashboard, "function SubredditPerformanceTable", "\n}\n");
  assert.match(body, /styles\.subredditTopHeader/);
  assert.match(body, /styles\.subredditTopFootnote/);
  assert.equal(/styles\.subredditTopScope/.test(body), false);
  // The footnote is no longer italic top-right metadata -- it's a plain, muted line.
  const cssBody = css.slice(css.indexOf(".subredditTopFootnote {"), css.indexOf(".subredditTopFootnote {") + 150);
  assert.equal(/font-style: italic;/.test(cssBody), false);
});

test("the data list no longer draws a full grid line around every cell -- horizontal row separators only (one shared rule on the non-header grid rows), matching a real analytics product rather than a spreadsheet export", () => {
  const cssBody = css.slice(css.indexOf(".subredditTopGrid:not(.subredditTopGridHead) {"), css.indexOf(".subredditTopGrid:not(.subredditTopGridHead) {") + 150);
  assert.match(cssBody, /border-bottom: 1px solid var\(--line\);/);
  assert.equal(/border: 1px solid|border-left|border-right/.test(cssBody), false);
});

test("numeric columns use tabular figures and header/data cells share one right-alignment modifier class, so header labels and values are guaranteed the same alignment", () => {
  const cssBody = css.slice(css.indexOf(".subredditNumericCell {"), css.indexOf(".subredditNumericCell {") + 200);
  assert.match(cssBody, /font-variant-numeric: tabular-nums;/);
  const rightCss = css.slice(css.indexOf(".subredditGridCellRight {"), css.indexOf(".subredditGridCellRight {") + 100);
  assert.match(rightCss, /text-align: right;/);
});

test("row hover state exists with a smooth transition, and the previous permanent top-row background emphasis was deliberately removed per explicit direction", () => {
  const body = fnBody(dashboard, "function SubredditPerformanceTable", "\n}\n");
  assert.equal(/subredditTopRow\b/.test(body), false);
  const hoverCss = css.slice(css.indexOf(".subredditTopGrid:not(.subredditTopGridHead):hover {"), css.indexOf(".subredditTopGrid:not(.subredditTopGridHead):hover {") + 100);
  assert.match(hoverCss, /background: #f7f9fc;/);
  const transitionCss = css.slice(css.indexOf(".subredditTopGrid:not(.subredditTopGridHead) {"), css.indexOf(".subredditTopGrid:not(.subredditTopGridHead) {") + 150);
  assert.match(transitionCss, /transition: background-color 140ms ease;/);
});

test("Subreddit is rendered as the visual anchor of each row with a semibold (not heavy-bold) weight, per the specified 500-600 range", () => {
  const body = fnBody(dashboard, "function SubredditPerformanceTable", "\n}\n");
  assert.match(body, /styles\.subredditNameCell\}`\} role="cell">r\/\{row\.subreddit\}/);
  const cssBody = css.slice(css.indexOf(".subredditNameCell {"), css.indexOf(".subredditNameCell {") + 100);
  assert.match(cssBody, /font-weight: 600;/);
});

test("Avg relevance is styled text for an ordinary score (a metric, not a generic gray chip) -- only a genuinely high score earns a subtle blue-tinted badge, reusing the existing blue accent tokens", () => {
  const body = fnBody(dashboard, "function SubredditPerformanceTable", "\n}\n");
  assert.match(body, /row\.avgRelevance >= 85 \? \(\s*<span className=\{styles\.subredditScoreHigh\}>\{row\.avgRelevance\}<\/span>/);
  assert.match(body, /<span className=\{styles\.subredditScore\}>\{row\.avgRelevance\}<\/span>/);
  const cssBody = css.slice(css.indexOf(".subredditScoreHigh {"), css.indexOf(".subredditScoreHigh {") + 250);
  assert.match(cssBody, /var\(--green-soft\)/);
  assert.match(cssBody, /var\(--green-dark\)/);
});

test("the high-score badge has an explicit minimum width in the specified 28-34px range, not left to shrink-wrap arbitrarily; the ordinary score has no badge shape at all", () => {
  const cssBody = css.slice(css.indexOf(".subredditScoreHigh {"), css.indexOf(".subredditScoreHigh {") + 200);
  assert.match(cssBody, /min-width: 30px;/);
  const ordinaryCss = css.slice(css.indexOf(".subredditScore {"), css.indexOf(".subredditScore {") + 100);
  assert.equal(/background|border-radius|padding/.test(ordinaryCss), false);
});

test("Opportunities gets a distinct, stronger visual treatment than a plain number when its value is genuinely positive -- Scooptr blue text, not a giant badge", () => {
  const body = fnBody(dashboard, "function SubredditPerformanceTable", "\n}\n");
  assert.match(body, /row\.opportunities > 0 \? \(\s*<span className=\{styles\.subredditOpportunitiesValue\}>\{row\.opportunities\}<\/span>/);
  const cssBody = css.slice(css.indexOf(".subredditOpportunitiesValue {"), css.indexOf(".subredditOpportunitiesValue {") + 100);
  assert.match(cssBody, /color: var\(--green-dark\);/);
  assert.equal(/border-radius|background/.test(cssBody), false);
});

test("AI cited shows real blue text when there is a real citation count, and a muted zero otherwise -- no fabricated signal", () => {
  const body = fnBody(dashboard, "function SubredditPerformanceTable", "\n}\n");
  assert.match(body, /row\.aiCited > 0 \? <span className=\{styles\.subredditAiCited\}>\{row\.aiCited\}<\/span> : <span className=\{styles\.subredditMuted\}>0<\/span>/);
});

test("AI cited is plain blue text with no pill/badge shape at all, so it never reads louder than Opportunities or the Avg relevance high-score badge next to it", () => {
  const aiCss = css.slice(css.indexOf(".subredditAiCited {"), css.indexOf(".subredditAiCited {") + 150);
  assert.equal(/background|border-radius|padding/.test(aiCss), false);
  assert.match(aiCss, /color: var\(--green-dark\);/);
});

test("zero-value relevant-conversations and opportunities cells are visually muted, distinct from real positive values", () => {
  const body = fnBody(dashboard, "function SubredditPerformanceTable", "\n}\n");
  assert.match(body, /row\.relevantConversations > 0 \? row\.relevantConversations : <span className=\{styles\.subredditMuted\}>0<\/span>/);
  assert.match(body, /row\.opportunities > 0 \? \(/);
});

test("Latest is rendered quieter/secondary than the other numeric cells", () => {
  const body = fnBody(dashboard, "function SubredditPerformanceTable", "\n}\n");
  assert.match(body, /styles\.subredditLatestCell/);
  const cssBody = css.slice(css.indexOf(".subredditLatestCell {"), css.indexOf(".subredditLatestCell {") + 100);
  assert.match(cssBody, /color: var\(--faint\);/);
});

test("the existing safe mobile horizontal-scroll wrapper is preserved unchanged -- .subredditTableScroll still wraps the grid, and the grid container has its own min-width so the scroll actually engages on a narrow viewport", () => {
  const body = fnBody(dashboard, "function SubredditPerformanceTable", "\n}\n");
  assert.match(body, /styles\.subredditTableScroll/);
  assert.match(css, /\.subredditTopGridContainer \{\s*\n\s*min-width: 560px;/);
});

test("the real, supplied Reddit logo image asset sits next to the section title -- never recreated with CSS/an icon library/emoji, sized subtly (~22px) at its correct square aspect ratio", () => {
  const body = fnBody(dashboard, "function SubredditPerformanceTable", "\n}\n");
  assert.match(body, /src="\/logos\/reddit-mark\.png"/);
  assert.match(body, /width=\{22\} height=\{22\}/);
  const cssBody = css.slice(css.indexOf(".subredditTopIcon {"), css.indexOf(".subredditTopIcon {") + 150);
  assert.match(cssBody, /width: 22px;/);
  assert.match(cssBody, /height: 22px;/);
});

test("a muted subreddit count sits next to the title, shown only once there are real rows to count", () => {
  const body = fnBody(dashboard, "function SubredditPerformanceTable", "\n}\n");
  assert.match(body, /data && data\.rows\.length > 0 && <span className=\{styles\.subredditTopCount\}>\{data\.rows\.length\}<\/span>/);
});

test("one shared grid-template-columns definition is used for both the header row and every data row -- defined exactly once in .subredditTopGrid, never independently on header vs. rows", () => {
  const gridDefinitions = css.match(/grid-template-columns: minmax\(140px, 2fr\)[^;]*;/g) ?? [];
  assert.equal(gridDefinitions.length, 1);
  const body = fnBody(dashboard, "function SubredditPerformanceTable", "\n}\n");
  const gridClassUses = body.match(/styles\.subredditTopGrid\b/g) ?? [];
  // Used on both the header row and the per-row div -- at least twice.
  assert.ok(gridClassUses.length >= 2);
});

test("column proportions favor Subreddit as the largest flexible share, with Relevant conversations wide enough for its own long label, Opportunities/Avg. relevance narrower, AI cited compact, and Latest wide enough for a string like '217 days ago'", () => {
  const gridCss = css.slice(css.indexOf(".subredditTopGrid {"), css.indexOf(".subredditTopGrid {") + 400);
  assert.match(gridCss, /minmax\(140px, 2fr\) minmax\(108px, 1\.15fr\) minmax\(76px, 0\.75fr\) minmax\(84px, 0\.85fr\) minmax\(64px, 0\.7fr\) minmax\(92px, 0\.95fr\)/);
});

test("no cell is individually nudged with its own margin/padding to force alignment -- every cell (header or data) shares one .subredditGridCell padding rule, with only a first-child left-padding exception applied identically to both", () => {
  const cellCss = css.slice(css.indexOf(".subredditGridCell {"), css.indexOf(".subredditGridCell {") + 100);
  assert.match(cellCss, /padding: 17px 0;/);
  const firstChildCss = css.slice(css.indexOf(".subredditGridCell:first-child {"), css.indexOf(".subredditGridCell:first-child {") + 100);
  assert.match(firstChildCss, /padding-left: 4px;/);
});

test("column header labels use title case, not the old all-caps spreadsheet-style transform -- no uppercase, no heavy letter-spacing", () => {
  const cssBody = css.slice(css.indexOf(".subredditTopGridHead .subredditGridCell {"), css.indexOf(".subredditTopGridHead .subredditGridCell {") + 200);
  assert.equal(/text-transform: uppercase;/.test(cssBody), false);
  assert.equal(/letter-spacing: 0\.\d/.test(cssBody), false);
});

test("the two insight cards above the table (Best opportunity source, Communities influencing AI answers) use a softer label than the shared, heavily-uppercase .eyebrow class used broadly elsewhere -- and that shared class itself is untouched", () => {
  const bestBody = fnBody(dashboard, "function BestOpportunitySourceCard", "\n}\n");
  const aiBody = fnBody(dashboard, "function AiCitedCommunitiesCard", "\n}\n");
  assert.match(bestBody, /styles\.analyticsInsightLabel/);
  assert.match(aiBody, /styles\.analyticsInsightLabel/);
  assert.equal(/styles\.eyebrow/.test(bestBody), false);
  assert.equal(/styles\.eyebrow/.test(aiBody), false);
  const cssBody = css.slice(css.indexOf(".analyticsInsightLabel {"), css.indexOf(".analyticsInsightLabel {") + 200);
  assert.equal(/text-transform: uppercase;/.test(cssBody), false);
  // The shared .eyebrow rule itself is unchanged -- still exists as-is for its other, broad usage.
  assert.match(css, /^\.eyebrow \{/m);
});

test("no sort logic, column IDs, data source, or business logic changed in this visual pass -- only presentation", () => {
  const body = fnBody(dashboard, "function SubredditPerformanceTable", "\n}\n");
  assert.match(body, /sortSubredditRows\(data\?\.rows \?\? \[\], sortColumn, sortDirection\)/);
  assert.match(body, /\[\.\.\.\(data\?\.rows \?\? \[\]\)\]\.sort\(defaultSubredditSort\)/);
  assert.equal(/[+-]\d+%|vs\. previous|2x|better than average/i.test(body), false);
});
