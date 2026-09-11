import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Dashboard-honesty and history notes:
 *
 * 1. The "Results" tab rendered `data.lockedCounts` (additional findings
 *    hidden behind a paywall) under the headline "Everything this scan
 *    found." When nothing was hidden -- full access, or just a small scan --
 *    every count is legitimately zero, so the tab read as "this scan found
 *    nothing," directly contradicting the Overview tab's real totals.
 * 2. The "Replies" tab (which counted and listed drafted/posted replies
 *    separately from the Opportunities carousel, including a fix for a
 *    former undercounting bug there) has since been removed entirely --
 *    it duplicated the same opportunities the Tinder-style carousel
 *    already covers one at a time with the full generate/edit/publish
 *    flow. Its own sessionOnlyDraftedConversations derivation was
 *    removed along with it. The underlying carouselItems invariant that
 *    fix depended on (built from both relevantConversations AND
 *    scanEvidence.candidates) is still worth guarding below, since
 *    carouselItems itself is still very much alive and used elsewhere.
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

test("the Replies tab and its content block no longer exist -- removed as a duplicate of the Opportunities carousel", () => {
  assert.equal(/activeSection === "replies"/.test(dashboardSource), false);
  assert.equal(/sessionOnlyDraftedConversations/.test(dashboardSource), false);
});

test("carouselItems (still used by Opportunities and elsewhere) continues to be built from both relevantConversations AND scanEvidence.candidates -- the invariant the now-removed Replies-tab fix depended on", () => {
  // Guards against a future change silently narrowing carouselItems back
  // to a single source, the same regression the old Replies-tab fix caught.
  const carouselStart = dashboardSource.indexOf("const carouselItems = useMemo<CarouselItem[]>(");
  const carouselEnd = dashboardSource.indexOf("hasAnyRelevantContent", carouselStart);
  const carouselSource = dashboardSource.slice(carouselStart, carouselEnd);
  assert.match(carouselSource, /relevantConversations\.map/);
  assert.match(carouselSource, /data\.scanEvidence\?\.candidates/);
  assert.match(carouselSource, /candidateAsRelevantConversation/);
});

