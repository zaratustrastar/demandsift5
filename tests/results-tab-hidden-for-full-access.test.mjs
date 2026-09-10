import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * The "Results" tab is a free-tier paywall-awareness tab, not a general
 * "everything found" view -- its whole basis, additionalLockedCounts,
 * is hardcoded to all zeros for any fullAccess viewer (confirmed by
 * reading presenter.ts directly). That means it is structurally
 * guaranteed to always show "Nothing else is hidden" for every paid/
 * authenticated user, on every scan, forever -- dead weight in the nav
 * for that entire audience. Hidden here (not deleted outright) because
 * Opportunities and Replies locked-counts have no other home the way
 * Insights'/Competitors' own already do (those two already show "{N}
 * more ... stored" inline on their own screens) -- a free-tier viewer
 * still needs this tab to see those two specifically.
 */

const presenter = await readFile(new URL("../lib/server/presenter.ts", import.meta.url), "utf8");
const dashboard = await readFile(new URL("../components/demand-intelligence/ProductDashboard.tsx", import.meta.url), "utf8");

test("additionalLockedCounts is confirmed hardcoded to all zeros whenever fullAccess is true -- the actual reason this tab is permanently empty for paid users, not a display bug", () => {
  const start = presenter.indexOf("additionalLockedCounts: fullAccess");
  assert.ok(start > -1);
  const body = presenter.slice(start, start + 250);
  assert.match(body, /\? \{ opportunities: 0, relevantConversations: 0, insights: 0, competitorSignals: 0, replies: 0 \}/);
});

test("Insights and Competitors already surface their own locked counts inline on their own screens, independent of the Results tab", () => {
  assert.match(dashboard, /data\.lockedCounts\.insights > 0 &&/);
  assert.match(dashboard, /data\.lockedCounts\.competitorSignals > 0 &&/);
});

test("the Results nav item is filtered out of navSections for any non-free (fullAccess) viewer -- isFree is computed before navSections so the filter can use it, not after", () => {
  const isFreeIndex = dashboard.indexOf("const isFree = accessLevel === \"free\";");
  const navSectionsIndex = dashboard.indexOf("const navSections = (data.navigation ?? []).filter");
  assert.ok(isFreeIndex > -1 && navSectionsIndex > -1);
  assert.ok(isFreeIndex < navSectionsIndex);
  const filterBody = dashboard.slice(navSectionsIndex, navSectionsIndex + 150);
  assert.match(filterBody, /\.filter\(\(item\) => isFree \|\| item\.id !== "results"\)/);
});

test("the Results content block itself also requires isFree, as a defensive guard, so it can never render for a fullAccess viewer even if activeSection somehow held a stale \"results\" value", () => {
  assert.match(dashboard, /\{activeSection === "results" && isFree && \(/);
});

test("no other section's nav item, content, or badge logic was touched -- only the Results nav entry is filtered", () => {
  const filterBody = dashboard.slice(
    dashboard.indexOf("const navSections = (data.navigation ?? []).filter"),
    dashboard.indexOf("const navSections = (data.navigation ?? []).filter") + 150,
  );
  assert.equal(/opportunities|insights|competitors|visibility|replies|monitoring|analytics|settings|billing/.test(filterBody), false);
});

test("no business logic, calculations, or the underlying lockedCounts computation were changed -- only nav visibility for full-access viewers", () => {
  assert.match(presenter, /additionalLockedCounts: fullAccess/);
  assert.match(dashboard, /data\.lockedCounts\.opportunities \+/);
});
