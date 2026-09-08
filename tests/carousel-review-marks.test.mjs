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

test("marking a status no longer explicitly advances the index -- filtering makes that unnecessary (see the filter-aware auto-advance test below)", () => {
  const fnStart = dashboard.indexOf("const handleSetReviewStatus");
  assert.ok(fnStart > -1);
  const fnBody = dashboard.slice(fnStart, fnStart + 250);
  assert.match(fnBody, /const next = currentReviewStatus === status \? null : status;/);
  assert.match(fnBody, /onSetReviewMark\(item\.id, next\);/);
  assert.equal(fnBody.includes("goTo("), false);
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

/**
 * Filtering feature: New | Reviewed | Replied | Declined | All, added
 * directly above the existing card. Counts and filtering are derived
 * locally from the same items + reviewMarks the carousel already had --
 * confirmed by inspection that all opportunities are already client-side
 * (dashboardData/carouselItems), so no new API/backend architecture was
 * needed. The existing mark-setting/persistence logic (recordReviewMark,
 * the API route, the optimistic overlay) is untouched by any of this.
 */
test("the five filter tabs match the spec exactly, in order, and counts come from the full unfiltered items list", () => {
  assert.match(dashboard, /const REVIEW_FILTER_TABS: Array<\{ id: ReviewFilter; label: string \}> = \[\s*\{ id: "new", label: "New" \},\s*\{ id: "reviewed", label: "Reviewed" \},\s*\{ id: "replied", label: "Replied" \},\s*\{ id: "declined", label: "Declined" \},\s*\{ id: "all", label: "All" \},\s*\];/);
  const countsStart = dashboard.indexOf("const counts = useMemo(");
  assert.ok(countsStart > -1);
  const countsBody = dashboard.slice(countsStart, countsStart + 500);
  assert.match(countsBody, /for \(const candidate of items\) \{/);
  assert.match(countsBody, /all: items\.length/);
});

test("matchesReviewFilter implements New = no mark, All = everything, and each named filter = that exact status", () => {
  const fnStart = dashboard.indexOf("function matchesReviewFilter");
  const fnBody = dashboard.slice(fnStart, dashboard.indexOf("\n}\n", fnStart));
  assert.match(fnBody, /if \(filter === "all"\) return true;/);
  assert.match(fnBody, /if \(filter === "new"\) return status === null;/);
  assert.match(fnBody, /return status === filter;/);
});

test("filtering never re-sorts -- it filters the already relevance-sorted items array in place", () => {
  assert.match(
    dashboard,
    /const filteredItems = useMemo\(\s*\(\) => items\.filter\(\(candidate\) => matchesReviewFilter\(reviewFilter, reviewMarks\[candidate\.id\] \?\? null\)\),/,
  );
});

test("switching filters resets to the first matching conversation (index 0), set during render rather than in a useEffect", () => {
  const carouselStart = dashboard.indexOf("function OpportunityCarousel");
  const carouselBody = dashboard.slice(carouselStart, carouselStart + 3000);
  assert.match(carouselBody, /if \(reviewFilter !== indexFilter\) \{\s*setIndexFilter\(reviewFilter\);\s*setIndex\(0\);\s*\}/);
  // Specifically not a useEffect for this -- avoids an extra render pass,
  // and was caught as a real lint error (react-hooks/set-state-in-effect)
  // during implementation.
  assert.equal(/useEffect\(\(\) => \{\s*setIndex\(0\)/.test(carouselBody), false);
});

test("the position indicator (e.g. 'Reviewed -> 1 of 14') reflects the filtered list's own length, not the full unfiltered count", () => {
  assert.match(dashboard, /const total = filteredItems\.length;/);
  assert.match(dashboard, /\{safeIndex \+ 1\} of \{total\}/);
});

test("an empty filter shows a simple 'No <filter> conversations yet' message instead of the carousel silently rendering nothing", () => {
  const carouselStart = dashboard.indexOf("function OpportunityCarousel");
  const carouselBody = dashboard.slice(carouselStart, carouselStart + 4000);
  assert.match(carouselBody, /No \{emptyLabel\} conversations yet\./);
  assert.equal(carouselBody.includes("if (!item) return null;"), false);
});

test("only the previous/next arrows plus filter switching move the position -- both navigate the filtered list", () => {
  const carouselStart = dashboard.indexOf("function OpportunityCarousel");
  const carouselBody = dashboard.slice(carouselStart, carouselStart + 5000);
  assert.match(carouselBody, /const item = filteredItems\[safeIndex\];/);
});

/**
 * Relevance score display: the existing 0-100 ranking score every carousel
 * item already carries (CarouselItem.reliability, already used to sort the
 * carousel) is now also shown on the card, via the same reliability value
 * threaded straight through rather than recomputed. Two pieces of "AI
 * reliability/relevance" boilerplate copy were removed in the same change
 * (a section-header note and the carousel's own footer caption) in favor
 * of showing the real number directly.
 */
test("RelevanceBadge displays the existing CarouselItem.reliability score, clamped/rounded for display only -- not a new scoring computation", () => {
  const fnStart = dashboard.indexOf("function RelevanceBadge");
  const fnBody = dashboard.slice(fnStart, dashboard.indexOf("\n}\n", fnStart));
  assert.match(fnBody, /const rounded = Math\.round\(Math\.max\(0, Math\.min\(100, score\)\)\);/);
  assert.match(fnBody, /<strong>\{rounded\}<\/strong>/);
});

test("the high-relevance label is a single transparent threshold, not a multi-tier legend", () => {
  const fnStart = dashboard.indexOf("function RelevanceBadge");
  const fnBody = dashboard.slice(fnStart, dashboard.indexOf("\n}\n", fnStart));
  assert.match(fnBody, /rounded >= 85 \? "High relevance" : "relevance"/);
  // Only one threshold check in the whole function -- not a low/medium/high ladder.
  assert.equal((fnBody.match(/rounded >=/g) ?? []).length, 1);
});

test("both card kinds pass their item's own reliability value into the shared RelevanceBadge, using the same CarouselItem field that already sorts the carousel", () => {
  assert.match(dashboard, /reliability=\{item\.reliability\}/g);
  const opportunityCardStart = dashboard.indexOf("function CarouselOpportunityCard");
  const relevantCardStart = dashboard.indexOf("function CarouselRelevantCard");
  const opportunityCardBody = dashboard.slice(opportunityCardStart, dashboard.indexOf("\n}\n", opportunityCardStart));
  const relevantCardBody = dashboard.slice(relevantCardStart, dashboard.indexOf("\n}\n", relevantCardStart));
  for (const body of [opportunityCardBody, relevantCardBody]) {
    assert.match(body, /<RelevanceBadge score=\{reliability\} \/>/);
  }
});

test("the badge reuses .reliabilityBadge's existing color tokens (green-soft, green-dark) rather than introducing new colors", () => {
  assert.match(dashboardCss, /\.relevanceBadge \{/);
  const badgeStart = dashboardCss.indexOf(".relevanceBadge {");
  const badgeBlock = dashboardCss.slice(badgeStart, badgeStart + 400);
  assert.match(badgeBlock, /background: var\(--green-soft\);/);
  assert.match(badgeBlock, /color: var\(--green-dark\);/);
});

test("the two specified boilerplate strings were removed from the carousel section, and no unrelated screen's copy was touched", () => {
  assert.equal(dashboard.includes("AI relevance checked"), false);
  assert.equal(dashboard.includes("Ordered by AI reliability, highest first. Later conversations may be less reliable."), false);
  // The similarly-worded but distinct "Worth your time today" overview
  // section's own copy is a different screen and must be untouched.
  assert.match(dashboard, /<span>Ordered by AI reliability, highest first<\/span>/);
});

