import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Two dashboard-honesty bugs, found by walking the product as a first-time
 * user rather than reading the code:
 *
 * 1. The "Results" tab rendered `data.lockedCounts` (additional findings
 *    hidden behind a paywall) under the headline "Everything this scan
 *    found." When nothing was hidden -- full access, or just a small scan --
 *    every count is legitimately zero, so the tab read as "this scan found
 *    nothing," directly contradicting the Overview tab's real totals.
 * 2. The "Replies" tab counted and listed only `data.opportunities` (server-
 *    persisted). A reply generated live via "Create reply" on a relevant-
 *    but-not-yet-an-opportunity conversation is held in local-only
 *    `createdReplies` state and never reached this tab, so a reply you had
 *    just successfully drafted did not appear, and "drafted" undercounted.
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");
const dashboardSource = await read("../components/demand-intelligence/ProductDashboard.tsx");

function sectionSource(marker, nextMarker) {
  const start = dashboardSource.indexOf(marker);
  assert.ok(start > -1, `expected to find ${JSON.stringify(marker)}`);
  const end = nextMarker ? dashboardSource.indexOf(nextMarker, start) : dashboardSource.length;
  assert.ok(end > start, `expected to find ${JSON.stringify(nextMarker)} after the marker`);
  return dashboardSource.slice(start, end);
}

test("the Results tab no longer claims 'Everything this scan found' for a locked-content count", () => {
  const results = sectionSource(
    'activeSection === "results"',
    'activeSection === "monitoring"',
  );
  // The old, misleading unconditional headline must be gone -- it's fine for
  // the honest zero-state copy to say everything found "is already visible",
  // but not to claim a raw locked-count total "is everything this scan found".
  assert.equal(results.includes("<span className={styles.simpleCardTitle}>Everything this scan found</span>"), false);
  assert.equal(dashboardSource.includes('results: "Everything this scan found'), false);
  // A zero-locked-count scan gets its own honest copy instead of "0 of everything".
  assert.match(results, /Nothing else is hidden/);
  assert.match(results, /already visible in Opportunities/);
  // A genuinely nonzero locked count still shows the counts, correctly framed.
  assert.match(results, /More is stored than shown here/);
});

test("the Replies tab counts and lists replies created this session via 'Create reply'", () => {
  const replies = sectionSource(
    'activeSection === "replies"',
    'activeSection === "results"',
  );
  assert.match(replies, /sessionOnlyDraftedConversations/);
  // The headline count must include session-only drafts, not just
  // server-persisted opportunities.
  assert.match(
    replies,
    /rankedOpportunities\.length\s*\+\s*sessionOnlyDraftedConversations\.length/,
  );
  // The list itself must render those session-only drafts, not just count them.
  assert.match(replies, /sessionOnlyDraftedConversations\.map/);
});

test("session-only drafted conversations are derived from createdReplies, not a separate source of truth", () => {
  assert.match(
    dashboardSource,
    /sessionOnlyDraftedConversations\s*=\s*useMemo\(/,
  );
  const memoStart = dashboardSource.indexOf("const sessionOnlyDraftedConversations = useMemo(");
  const memoEnd = dashboardSource.indexOf(");", memoStart);
  const memoSource = dashboardSource.slice(memoStart, memoEnd);
  assert.match(memoSource, /relevantConversations/);
  assert.match(memoSource, /createdReplies\[conversation\.id\]/);
});
