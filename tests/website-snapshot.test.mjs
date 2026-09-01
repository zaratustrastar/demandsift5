import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./helpers/load-ts-module.mjs";
import { scanWorkflowHarness, websiteEvidenceFixture } from "./helpers/scan-workflow-harness.mjs";
const { createWebsiteSnapshot, reusableWebsiteSnapshot, legacyProfileMatchesSnapshot } = await loadTsModule("lib/server/website-snapshot.ts");

test("snapshots retain all normalized pages and stable source IDs without sharing mutable references", () => {
  const crawl = websiteEvidenceFixture();
  const snapshot = createWebsiteSnapshot("scan_one", crawl.requestedUrl, crawl);
  assert.equal(snapshot.crawl.pages.length, 4); assert.equal(snapshot.crawl.pages[0].text, crawl.pages[0].text);
  assert.ok(reusableWebsiteSnapshot(snapshot, "scan_one", crawl.requestedUrl));
  assert.equal(reusableWebsiteSnapshot(snapshot, "scan_two", crawl.requestedUrl), false);
  assert.equal(reusableWebsiteSnapshot(snapshot, "scan_one", "https://different-business.com"), false);
  crawl.pages[0].text = "caller mutated its local result";
  assert.ok(reusableWebsiteSnapshot(snapshot, "scan_one", snapshot.inputUrl));
  snapshot.crawl.pages[0].text = "tampered snapshot";
  assert.equal(reusableWebsiteSnapshot(snapshot, "scan_one", snapshot.inputUrl), false);
});
test("empty or oversized results cannot become successful four-page snapshots", () => {
  assert.throws(() => createWebsiteSnapshot("scan", "https://fixture-business.com/", websiteEvidenceFixture(0)), /one to four/);
  assert.throws(() => createWebsiteSnapshot("scan", "https://fixture-business.com/", websiteEvidenceFixture(5)), /one to four/);
});
test("legacy source matching requires real matching citation IDs", () => {
  const crawl = websiteEvidenceFixture(); const snapshot = createWebsiteSnapshot("scan", crawl.requestedUrl, crawl);
  assert.equal(legacyProfileMatchesSnapshot([], snapshot), false);
  assert.equal(legacyProfileMatchesSnapshot(["web_unknown"], snapshot), false);
  assert.equal(legacyProfileMatchesSnapshot(snapshot.crawl.pages.map(page => page.sourceId), snapshot), true);
});

test("actual analyze -> approved profile -> run reuses one successful four-page crawl", async t => {
  const fixture = await scanWorkflowHarness(t, { inputMode: "website", analyzed: false });
  await fixture.workflow.runScan(fixture.scan.id, { stopAfterUnderstanding: true });
  const approved = structuredClone(fixture.scan.discoveryProfile);
  assert.equal(fixture.state.crawlCalls.length, 1); assert.equal(fixture.state.analysisCalls.length, 1);
  assert.equal(fixture.state.crawlCalls[0].options.maxPages, 4);
  assert.equal(fixture.state.analysisCalls[0].pages.length, 4);
  assert.equal(approved.websiteSnapshotId, fixture.scan.websiteSnapshot.id);
  const sources = new Set(fixture.scan.websiteSnapshot.crawl.pages.map(page => page.sourceId));
  assert.ok(approved.profile.sourceIds.every(id => sources.has(id)));
  await assert.rejects(fixture.workflow.runScan(fixture.scan.id), error => error === fixture.stop);
  assert.equal(fixture.state.crawlCalls.length, 1); assert.equal(fixture.state.analysisCalls.length, 1);
  assert.deepEqual(fixture.scan.discoveryProfile, approved, "approved terms/profile stay unchanged");
});

test("AI retry reuses durable website evidence instead of repeating the crawl", async t => {
  const fixture = await scanWorkflowHarness(t, { inputMode: "website", analyzed: false });
  const analyze = fixture.state.ai.analyzeBusiness; let attempts = 0;
  fixture.state.ai.analyzeBusiness = async request => {
    attempts += 1;
    assert.ok(fixture.saved.some(row => row.websiteSnapshot), "snapshot must be saved before AI");
    if (attempts === 1) throw new Error("synthetic AI failure");
    return analyze(request);
  };
  await fixture.workflow.runScan(fixture.scan.id, { stopAfterUnderstanding: true });
  assert.equal(attempts, 2); assert.equal(fixture.state.crawlCalls.length, 1);
});

test("a successful crawl survives a whole failed analysis invocation and later resume", async t => {
  const fixture = await scanWorkflowHarness(t, { inputMode: "website", analyzed: false });
  const analyze = fixture.state.ai.analyzeBusiness;
  fixture.state.ai.analyzeBusiness = async () => { throw new Error("synthetic exhausted AI failure"); };
  await assert.rejects(fixture.workflow.runScan(fixture.scan.id, { stopAfterUnderstanding: true }), /exhausted AI/);
  const snapshotId = fixture.scan.websiteSnapshot.id;
  fixture.state.ai.analyzeBusiness = analyze;
  await fixture.workflow.runScan(fixture.scan.id, { stopAfterUnderstanding: true });
  assert.equal(fixture.state.crawlCalls.length, 1); assert.equal(fixture.scan.discoveryProfile.websiteSnapshotId, snapshotId);
});

test("snapshot persistence failure is retried before paid analysis without another crawl", async t => {
  const fixture = await scanWorkflowHarness(t, { inputMode: "website", analyzed: false });
  const save = fixture.state.repository.saveScan; let rejected = false;
  fixture.state.repository.saveScan = async scan => {
    if (scan.websiteSnapshot && !rejected) { rejected = true; throw new Error("synthetic storage failure"); }
    return save(scan);
  };
  const analyze = fixture.state.ai.analyzeBusiness;
  fixture.state.ai.analyzeBusiness = async request => {
    assert.ok(fixture.saved.some(scan => scan.websiteSnapshot));
    return analyze(request);
  };
  await fixture.workflow.runScan(fixture.scan.id, { stopAfterUnderstanding: true });
  assert.equal(fixture.state.crawlCalls.length, 1); assert.equal(rejected, true);
});

test("website progress reports two actually read pages, not a hardcoded four", async t => {
  const fixture = await scanWorkflowHarness(t, { inputMode: "website", analyzed: false, crawlResult: websiteEvidenceFixture(2) });
  await fixture.workflow.runScan(fixture.scan.id, { stopAfterUnderstanding: true });
  assert.match(fixture.scan.progress.find(stage => stage.id === "website").detail, /^2 public pages read/);
});

test("context onboarding and run do not create or fetch a website snapshot", async t => {
  const fixture = await scanWorkflowHarness(t, { analyzed: false });
  await fixture.workflow.runScan(fixture.scan.id, { stopAfterUnderstanding: true });
  await assert.rejects(fixture.workflow.runScan(fixture.scan.id), error => error === fixture.stop);
  assert.equal(fixture.state.crawlCalls.length, 0); assert.equal(fixture.scan.websiteSnapshot, undefined);
});

test("legacy approved profiles recrawl once and bind only when citation hashes match", async t => {
  const fixture = await scanWorkflowHarness(t, { inputMode: "website" });
  await assert.rejects(fixture.workflow.runScan(fixture.scan.id), error => error === fixture.stop);
  assert.equal(fixture.state.crawlCalls.length, 1); assert.equal(fixture.state.analysisCalls.length, 0);
  assert.equal(fixture.scan.discoveryProfile.websiteSnapshotId, fixture.scan.websiteSnapshot.id);
});

test("changed legacy evidence cannot silently rewrite the approved profile", async t => {
  const fixture = await scanWorkflowHarness(t, { inputMode: "website" });
  fixture.scan.discoveryProfile.profile.sourceIds = ["web_no_longer_available"];
  await assert.rejects(fixture.workflow.runScan(fixture.scan.id), error => error.code === "website_snapshot_mismatch");
  assert.equal(fixture.state.crawlCalls.length, 1); assert.equal(fixture.state.analysisCalls.length, 0);
  assert.equal(fixture.submissions.length, 0);
});

test("a bound profile cannot use a tampered snapshot or a different website", async t => {
  const fixture = await scanWorkflowHarness(t, { inputMode: "website", analyzed: false });
  await fixture.workflow.runScan(fixture.scan.id, { stopAfterUnderstanding: true });
  const approvedUrl = fixture.scan.websiteUrl;
  fixture.scan.websiteUrl = "https://different-business.com/";
  await assert.rejects(fixture.workflow.runScan(fixture.scan.id), error => error.code === "website_snapshot_mismatch");
  fixture.scan.websiteUrl = approvedUrl;
  fixture.scan.websiteSnapshot.crawl.pages[0].text = "tampered";
  await assert.rejects(fixture.workflow.runScan(fixture.scan.id), error => error.code === "website_snapshot_mismatch");
  assert.equal(fixture.state.crawlCalls.length, 1);
});
