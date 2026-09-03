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

test("session-only drafted conversations are derived from carouselItems, not just relevantConversations", () => {
  // The first version of this fix filtered only `relevantConversations`,
  // missing conversations that only exist via the second carousel source
  // (scanEvidence.candidates, folded in through candidateAsRelevantConversation)
  // -- so a reply created on one of those never appeared here. Deriving from
  // carouselItems' own "relevant" items covers both sources by construction.
  assert.match(
    dashboardSource,
    /sessionOnlyDraftedConversations\s*=\s*useMemo\(/,
  );
  const memoStart = dashboardSource.indexOf("const sessionOnlyDraftedConversations = useMemo(");
  const memoEnd = dashboardSource.indexOf("[carouselItems, createdReplies]", memoStart);
  assert.ok(memoEnd > memoStart, "expected the memo to depend on carouselItems, not relevantConversations directly");
  const memoSource = dashboardSource.slice(memoStart, memoEnd);
  assert.match(memoSource, /carouselItems/);
  assert.match(memoSource, /item\.kind === "relevant"/);
  assert.match(memoSource, /createdReplies\[conversation\.id\]/);

  // Guard the invariant this fix relies on: carouselItems' "relevant" items
  // must still be built from both relevantConversations AND
  // scanEvidence.candidates. If a future change drops either source from
  // carouselItems, or reintroduces a separate parallel source, this fix's
  // coverage would silently narrow again the same way it did before.
  const carouselStart = dashboardSource.indexOf("const carouselItems = useMemo<CarouselItem[]>(");
  const carouselEnd = dashboardSource.indexOf("hasAnyRelevantContent", carouselStart);
  const carouselSource = dashboardSource.slice(carouselStart, carouselEnd);
  assert.match(carouselSource, /relevantConversations\.map/);
  assert.match(carouselSource, /data\.scanEvidence\?\.candidates/);
  assert.match(carouselSource, /candidateAsRelevantConversation/);
});
