import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadTsModule } from "./helpers/load-ts-module.mjs";
import { business } from "./fixtures/scan-replay/factories.mjs";
const { scanReviewVersion, approveScanRecord, scanPhase } = await loadTsModule("lib/server/scan-lifecycle.ts");
const scan = () => ({ id: "review_fixture", websiteUrl: "", inputMode: "context", contextText: "Original fixture business",
  status: "queued", phase: "awaiting_review", discoveryProfile: { profile: { name: "Fixture" }, business: structuredClone(business), profileStage: "full" } });

test("review version survives JSONB key reordering but detects changed evidence, terms and competitors", () => {
  const original = scan(), token = scanReviewVersion(original);
  const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reorder(child)])) : value;
  assert.equal(scanReviewVersion(reorder(original)), token);
  for (const change of [row => { row.contextText += " different"; }, row => { row.discoveryOverrides = { productTerms: ["different"] }; },
    row => { row.competitorProfiles = [{ name: "another" }]; }, row => { row.discoveryProfile.profile.name = "Changed"; },
    row => { row.discoveryProfile.business.productTerms.value = ["changed"]; }]) {
    const modified = structuredClone(original); change(modified);
    assert.notEqual(scanReviewVersion(modified), token);
  }
  original.discoveryProfile.websiteSnapshotId = "identical-legacy-evidence-binding";
  assert.equal(scanReviewVersion(original), token);
});

test("only the complete reviewed version can be approved", () => {
  const original = scan();
  assert.throws(() => approveScanRecord(original), { code: "scan_review_changed" });
  assert.throws(() => approveScanRecord(original, "stale"), { code: "scan_review_changed" });
  const token = scanReviewVersion(original), approved = approveScanRecord(original, token);
  assert.equal(approved.approval.version, token); assert.equal(approved.phase, "scan_queued");
  assert.equal(approveScanRecord(approved, token), approved);
  assert.throws(() => approveScanRecord({ ...original, discoveryProfile: null }, token), { code: "scan_review_required" });
  assert.throws(() => approveScanRecord({ ...original, discoveryProfile: { ...original.discoveryProfile, profileStage: "fast" } }, token), { code: "scan_review_required" });
  assert.throws(() => approveScanRecord({ ...original, execution: { active: true } }, token), { code: "scan_already_started" });
});

test("legacy unstarted profiles restore to review; accepted running work remains running", () => {
  assert.equal(scanPhase({ ...scan(), phase: undefined }), "awaiting_review");
  assert.equal(scanPhase({ status: "running" }), "scanning");
  assert.equal(scanPhase({ status: "queued" }), "created");
  assert.equal(scanPhase({ status: "failed", phase: "analyzing" }), "failed");
});

test("browser restoration polls only and review sends the displayed version", async () => {
  const source = await readFile(new URL("../components/ThreadlineExperience.tsx", import.meta.url), "utf8");
  const polling = source.slice(source.indexOf('if (view !== "scanning")'), source.indexOf("async function refreshScan"));
  assert.doesNotMatch(polling, /method: "POST"|defer: true/u);
  assert.match(source, /analysisScanRef\.current \?\?=/u);
  assert.match(source, /latest\.scan\.phase === "awaiting_review"/u);
  assert.match(source, /JSON\.stringify\(\{ reviewVersion \}\)/u);
});
