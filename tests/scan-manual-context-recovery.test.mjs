import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { scanWorkflowHarness } from "./helpers/scan-workflow-harness.mjs";

/**
 * A scan whose website could not be read at all (a permanent crawl
 * failure, including the sustained-503 case -- see
 * sustained-website-status-promotion.test.mjs) used to be a dead end:
 * "Run another scan" or "Reopen this saved scan", nothing else. There
 * was already a fully-built, already-live second way to reach a
 * BusinessUnderstanding -- inputMode: "context", the same pipeline
 * behind the "Describe your market / idea" tab -- so
 * resumeScanWithManualContext (lib/server/scan-workflow.ts) lets an
 * existing failed scan switch into that pipeline instead of the person
 * having to start an entirely new scan from scratch.
 *
 * These tests cover the function's actual behavior directly (not just
 * its shape in source), plus the route's own guard conditions as
 * source-pattern assertions, matching this codebase's established split
 * between the two techniques (see e.g. discovery-profile-lifecycle.test.mjs
 * for a route-as-source-text precedent).
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");
const describeRoute = await read("../app/api/scans/[scanId]/describe/route.ts");

test("resumeScanWithManualContext switches a failed website scan into a fresh, context-mode, analyze-ready state", async (t) => {
  const fixture = await scanWorkflowHarness(t, { inputMode: "website", analyzed: false });
  // Simulate exactly what runScan's own catch block leaves behind for a
  // terminal website failure (see scan-workflow.ts): a failed status, an
  // errorCode, a failed "website" stage, and (crucially) no
  // discoveryProfile -- the crawl never produced one.
  fixture.scan.status = "failed";
  fixture.scan.phase = "failed";
  fixture.scan.error = "Website returned HTTP 503.";
  fixture.scan.errorCode = "website_permanently_unreachable";
  fixture.scan.progress = fixture.scan.progress.map((stage) =>
    stage.id === "website" ? { ...stage, status: "failed", detail: "Website returned HTTP 503." } : stage,
  );

  const resumed = await fixture.workflow.resumeScanWithManualContext(
    fixture.scan,
    "A parental controls app for Android TV with daily time limits and no subscription.",
  );

  assert.equal(resumed.inputMode, "context");
  assert.equal(resumed.contextText, "A parental controls app for Android TV with daily time limits and no subscription.");
  assert.equal(resumed.websiteUrl, "");
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.phase, "created");
  assert.equal(resumed.reviewRequired, true);
  assert.equal(resumed.error, null);
  assert.equal(resumed.errorCode, null);
  assert.equal(resumed.discoveryProfile, undefined);
  assert.equal(resumed.competitorSuggestions, undefined);
  assert.equal(resumed.websiteSnapshot, undefined);
  assert.equal(resumed.durableJob, undefined);
  assert.equal(resumed.execution, undefined);
  // The stage list is reset clean, not left showing the earlier failed
  // "website" stage -- a fresh context-mode run reports its own progress
  // from scratch, same as any newly created scan.
  const websiteStage = resumed.progress.find((stage) => stage.id === "website");
  assert.equal(websiteStage.status, "pending");

  // Actually persisted, not just mutated in memory.
  assert.equal(fixture.saved.at(-1).inputMode, "context");
});

test("resumeScanWithManualContext + a direct runScan call takes the context branch and reaches awaiting_review, with no crawl", async (t) => {
  const fixture = await scanWorkflowHarness(t, { inputMode: "website", analyzed: false });
  fixture.scan.status = "failed";
  fixture.scan.errorCode = "website_permanently_unreachable";
  await fixture.workflow.resumeScanWithManualContext(fixture.scan, "A B2B invoicing tool for freelance designers.");

  // The describe route (app/api/scans/[scanId]/describe/route.ts) calls
  // runScan directly, right here, in the same request -- not by resetting
  // this scan to phase: "created" and leaving a later, separate
  // POST .../analyze call to pick it up. That deliberately sidesteps a
  // real bug found via live testing: acceptScanJob/insertScanJob dedupe a
  // "scan.analyze" job by scanId+type alone (see repository.ts), so a
  // second acceptance attempt for a scanId that already has one --
  // exactly this scan, from its original failed website attempt -- would
  // silently no-op instead of enqueueing anything, leaving the scan stuck
  // at phase: "created" forever. This harness's fake repository doesn't
  // implement that dedup constraint at all (its beginScanRun/acceptScanJob
  // stubs are trivial), so it cannot reproduce that specific failure mode
  // -- only the real, Postgres-backed repository can, which is how this
  // was actually caught. What this test does still confirm directly: the
  // context branch itself (runScan's inputMode === "context" handling)
  // works correctly when invoked this way, immediately after resume.
  const analyzed = await fixture.workflow.runScan(fixture.scan.id, { stopAfterUnderstanding: true });

  assert.equal(analyzed.phase, "awaiting_review");
  assert.equal(analyzed.status, "queued");
  assert.equal(analyzed.discoveryProfile.analysisMode, "openai");
  // The whole point: no crawl happened for the resumed scan.
  assert.equal(fixture.state.crawlCalls.length, 0);
});

test("the describe route runs the analysis directly (runScan), rather than resetting the scan for a separate POST .../analyze call to pick up later", () => {
  assert.match(describeRoute, /import \{ resumeScanWithManualContext, runScan \} from "@\/lib\/server\/scan-workflow";/);
  assert.match(describeRoute, /await resumeScanWithManualContext\(scan, contextText\);/);
  assert.match(describeRoute, /analyzed = await runScan\(scan\.id, \{ stopAfterUnderstanding: true \}\);/);
});

test("the describe route only allows the recovery action for a failed, not-yet-analyzed, non-context scan", () => {
  assert.match(describeRoute, /scan\.inputMode === "context"/);
  assert.match(describeRoute, /scan\.discoveryProfile/);
  assert.match(describeRoute, /scan\.status !== "failed"/);
});

test("the describe route validates contextText with the same bounds POST /api/scans uses at initial submission", () => {
  assert.match(describeRoute, /MIN_CONTEXT_TEXT_LENGTH = 20;/);
  assert.match(describeRoute, /MAX_CONTEXT_TEXT_LENGTH = 4_000;/);
});
