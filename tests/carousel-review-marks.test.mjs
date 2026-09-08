import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * The Reddit opportunity carousel had no persistent workflow state -- a
 * person could browse back and forth but never tell Scooptr a conversation
 * was reviewed, declined, or replied to. reviewMarks (ScanRecord.reviewMarks
 * in contracts.ts) adds exactly that: a small, id-keyed map of manual
 * triage marks, deliberately not named anything "triage*" like this
 * codebase's existing AI-relevance fields (triageCheckpoint,
 * triageProcessing) -- this is a personal workflow note, never a ranking
 * signal.
 */

const dashboard = await readFile(new URL("../components/demand-intelligence/ProductDashboard.tsx", import.meta.url), "utf8");
const dashboardCss = await readFile(new URL("../components/demand-intelligence/ProductDashboard.module.css", import.meta.url), "utf8");
const experience = await readFile(new URL("../components/ThreadlineExperience.tsx", import.meta.url), "utf8");
const contracts = await readFile(new URL("../lib/server/contracts.ts", import.meta.url), "utf8");
const presenter = await readFile(new URL("../lib/server/presenter.ts", import.meta.url), "utf8");
const fromScan = await readFile(new URL("../components/demand-intelligence/from-scan.ts", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/scans/[scanId]/review-mark/route.ts", import.meta.url), "utf8");

test("reviewMarks is a ScanRecord field distinct from this codebase's existing triage*-prefixed AI-relevance fields", () => {
  assert.match(contracts, /reviewMarks\?: Record<string, "reviewed" \| "declined" \| "replied">;/);
  // The AI-relevance fields it must not be confused with actually exist,
  // named with the triage prefix this field deliberately avoids.
  assert.match(contracts, /triageCheckpoint\?/);
  assert.match(contracts, /triageProcessing\?/);
});

test("reviewMarks is passed through presenter.ts and the client adapter without transformation", () => {
  assert.match(presenter, /reviewMarks: scan\.reviewMarks \?\? \{\}/);
  assert.match(fromScan, /reviewMarks: report\.reviewMarks \?\? \{\}/);
});

test("PATCH /api/scans/[scanId]/review-mark only accepts the three real statuses or null to clear, and requires a completed scan", () => {
  assert.match(route, /export async function PATCH/);
  assert.match(route, /ALLOWED_STATUSES = new Set\(\["reviewed", "declined", "replied"\]\)/);
  assert.match(route, /if \(!scan\.result\)/);
  assert.match(route, /rawStatus !== null/);
});

test("the route clears the mark on null (delete) rather than storing a null value", () => {
  assert.match(route, /if \(status === null\) delete reviewMarks\[itemId\];/);
});

test("ProductDashboard keeps an optimistic local overlay on top of the server-persisted reviewMarks, same pattern as publishedIds", () => {
  assert.match(dashboard, /const \[reviewMarkOverrides, setReviewMarkOverrides\] = useState</);
  assert.match(dashboard, /merged: Record<string, "reviewed" \| "declined" \| "replied"> = \{ \.\.\.\(data\.reviewMarks \?\? \{\}\) \}/);
});

test("clicking the already-active status undoes it; a different one switches directly", () => {
  const fnStart = dashboard.indexOf("const handleSetReviewStatus");
  assert.ok(fnStart > -1);
  const fnBody = dashboard.slice(fnStart, fnStart + 400);
  assert.match(fnBody, /const next = currentReviewStatus === status \? null : status;/);
});

test("declining or marking replied auto-advances to the next card; marking reviewed does not", () => {
  const fnStart = dashboard.indexOf("const handleSetReviewStatus");
  const fnBody = dashboard.slice(fnStart, fnStart + 400);
  assert.match(fnBody, /if \(next === "declined" \|\| next === "replied"\) goTo\(safeIndex \+ 1\);/);
  assert.equal(fnBody.includes('next === "reviewed") goTo'), false);
});

test("both carousel card kinds render the same shared review-actions row and status badge, not two separate implementations", () => {
  const opportunityCardStart = dashboard.indexOf("function CarouselOpportunityCard");
  const relevantCardStart = dashboard.indexOf("function CarouselRelevantCard");
  const opportunityCardBody = dashboard.slice(opportunityCardStart, dashboard.indexOf("\n}\n", opportunityCardStart));
  const relevantCardBody = dashboard.slice(relevantCardStart, dashboard.indexOf("\n}\n", relevantCardStart));
  for (const body of [opportunityCardBody, relevantCardBody]) {
    assert.match(body, /<ReviewStatusBadge status=\{reviewStatus\} \/>/);
    assert.match(body, /<ReviewActionsRow status=\{reviewStatus\} onSetStatus=\{onSetReviewStatus\} \/>/);
  }
});

test("the three actions use short existing-pattern labels, not a large toolbar of their own", () => {
  const rowStart = dashboard.indexOf("function ReviewActionsRow");
  const rowBody = dashboard.slice(rowStart, dashboard.indexOf("\n}\n", rowStart));
  assert.match(rowBody, />\s*Not relevant/);
  assert.match(rowBody, />\s*Reviewed/);
  assert.match(rowBody, />\s*Replied/);
  // aria-pressed makes each button's own current state explicit for
  // assistive tech, matching a toggle rather than a one-shot action.
  assert.match(rowBody, /aria-pressed=\{status === "declined"\}/);
});

test("recordReviewMark in ThreadlineExperience.tsx follows the same fetch/error pattern as recordResult, and is wired to ProductDashboard as onSetReviewMark", () => {
  const fnStart = experience.indexOf("async function recordReviewMark");
  assert.ok(fnStart > -1);
  const fnBody = experience.slice(fnStart, fnStart + 800);
  assert.match(fnBody, /fetch\(`\/api\/scans\/\$\{scanResponse\.scan\.id\}\/review-mark`, \{/);
  assert.match(fnBody, /method: "PATCH"/);
  assert.match(experience, /onSetReviewMark=\{recordReviewMark\}/);
});

test("the new CSS reuses this file's existing soft-pill color tokens (green-soft, amber-soft) rather than introducing new colors", () => {
  assert.match(dashboardCss, /\.reviewStatusReviewed \{ color: #1c6c49; background: var\(--green-soft\); \}/);
  assert.match(dashboardCss, /\.reviewStatusReplied \{ color: #87601d; background: var\(--amber-soft\); \}/);
  // No new CSS custom property was introduced for this feature.
  assert.equal(/--review[a-zA-Z-]*:/.test(dashboardCss), false);
});
