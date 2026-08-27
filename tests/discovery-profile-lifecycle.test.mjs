import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * The discovery-profile step only works if three things hold together: creating
 * a scan must not start Reddit retrieval, analysis must persist somewhere that
 * outlives it, and the review screen must read from that persisted analysis
 * rather than from a completed result. Any one of them regressing silently
 * restores the original lifecycle contradiction.
 */

const read = async (path) =>
  readFile(new URL(path, import.meta.url), "utf8");

const createRoute = await read("../app/api/scans/route.ts");
const analyzeRoute = await read("../app/api/scans/[scanId]/analyze/route.ts");
const termsRoute = await read("../app/api/scans/[scanId]/discovery-terms/route.ts");
const workflow = await read("../lib/server/scan-workflow.ts");
const experience = await read("../components/ThreadlineExperience.tsx");
const profileUi = await read("../components/DiscoveryProfile.tsx");
const dashboard = await read("../components/demand-intelligence/ProductDashboard.tsx");
const fromScan = await read("../components/demand-intelligence/from-scan.ts");

test("creating a scan for review does not start Reddit retrieval", () => {
  assert.match(createRoute, /body\.reviewFirst === true/);
  const reviewBranch = createRoute.indexOf("body.reviewFirst === true");
  // The call site, not the import at the top of the file.
  const enqueue = createRoute.indexOf("await enqueueScanRun(scan)");
  assert.ok(enqueue > -1, "expected an enqueue call site");
  assert.ok(
    reviewBranch < enqueue,
    "the review branch must return before anything is enqueued",
  );
});

test("analysis is persisted before retrieval and reused afterwards", () => {
  assert.match(workflow, /scan\.discoveryProfile = \{/);
  assert.match(workflow, /const persistedAnalysis = scan\.discoveryProfile;/);
  // Re-deriving would hand the user different terms from the ones approved.
  // The understanding step always persists a complete analysis now (the old
  // homepage-only "fast" tier that used to be excluded here is gone), so any
  // persisted profile is always safe to reuse -- see canReusePersistedAnalysis.
  assert.match(workflow, /const canReusePersistedAnalysis = Boolean\(persistedAnalysis\);/);
  assert.match(workflow, /if \(canReusePersistedAnalysis && persistedAnalysis\) \{/);
  const persistPoint = workflow.indexOf("scan.discoveryProfile = {");
  const discovery = workflow.indexOf('setStage(scan, "discovery", "active")');
  assert.ok(persistPoint < discovery, "the profile must exist before Reddit retrieval");
});

test("the analysis-only pass stops before Reddit and leaves the scan runnable", () => {
  assert.match(workflow, /options\.stopAfterUnderstanding/);
  assert.match(workflow, /scan\.status = "queued";/);
  assert.match(analyzeRoute, /stopAfterUnderstanding: true/);
});

test("the review screen reads persisted analysis, never a completed result", () => {
  assert.match(termsRoute, /const analysis = scan\.discoveryProfile;/);
  assert.equal(
    termsRoute.includes("scan.result?.profile"),
    false,
    "a result only exists after the scan these terms were meant to configure",
  );
});

test("all five understanding concepts reach the review screen", () => {
  for (const field of [
    "productTerms",
    "customerProblems",
    "competitors",
    "excludedTerms",
    "personas",
    "useCases",
    "purchaseTriggers",
  ]) {
    assert.ok(termsRoute.includes(`${field}:`), `discovery API omits ${field}`);
  }
});

test("the client flow is analyze then competitors then refining then review then scan", () => {
  // competitors and refining are both new, optional steps inserted between
  // the analyze call and the review screen -- the fast/preliminary profile
  // is never shown on its own, only after "refining" confirms it's the full
  // one.
  assert.match(experience, /type View =[\s\S]*"analyzing"[\s\S]*"competitors"[\s\S]*"refining"[\s\S]*"profile"/);
  assert.match(experience, /reviewFirst: true/);
  assert.match(experience, /\/analyze`/);

  // Scope to the main component so the RefiningProfile helper (defined
  // earlier in the file and also calling setView("profile")) can't produce
  // a false-positive textual match.
  const main = experience.slice(experience.indexOf("export function ThreadlineExperience()"));
  const analyze = main.indexOf("/analyze`");
  const setCompetitors = main.indexOf('setView("competitors")');
  assert.ok(analyze > -1 && setCompetitors > -1, "expected both the analyze call and the competitors transition");
  assert.ok(analyze < setCompetitors, "the competitors step must follow analysis, not precede it");

  // And the render branches themselves must appear in flow order.
  const competitorsBranch = main.indexOf('view === "competitors"');
  const refiningBranch = main.indexOf('view === "refining"');
  const profileBranch = main.indexOf('view === "profile"');
  assert.ok(
    competitorsBranch > -1 && refiningBranch > -1 && profileBranch > -1,
    "expected competitors, refining, and profile render branches",
  );
  assert.ok(
    competitorsBranch < refiningBranch && refiningBranch < profileBranch,
    "render branches must appear in flow order: competitors, then refining, then profile",
  );
});

test("editing is optional and Boolean syntax is never shown", () => {
  // The default path is analyze then press Scan Reddit.
  assert.match(profileUi, /Scan Reddit/);
  assert.match(profileUi, /if \(edited && terms\)/);
  for (const token of ["AND", "OR", "NOT"]) {
    assert.equal(
      new RegExp('"[^"]*\\b' + token + '\\b[^"]*"').test(profileUi),
      false,
      `the review screen must not expose ${token} syntax`,
    );
  }
});

test("themes render with inspectable evidence", () => {
  assert.match(dashboard, /What customers are struggling with/);
  assert.match(dashboard, /What they are asking for/);
  assert.match(dashboard, /Show evidence/);
  assert.match(dashboard, /theme\.evidence\.map/);
});

test("a theme count always equals the evidence it can show", () => {
  // Unresolvable evidence is dropped rather than shown as an unbacked claim.
  assert.match(fromScan, /conversationCount: evidence\.length/);
  assert.match(fromScan, /if \(evidence\.length === 0\) return \[\];/);
});

test("existing reply actions are preserved", () => {
  for (const action of ["Edit", "Copy", "Regenerate"]) {
    assert.ok(dashboard.includes(action), `reply action ${action} was lost`);
  }
});
