import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * The homepage-only "fast" preview tier (runFastUnderstanding,
 * refineDiscoveryProfile, analyzeBusinessFast) was deliberately removed: it
 * let a user review and approve terms from a quick, cheap-model pass, then
 * had runScan's own canReusePersistedAnalysis rule discard everything not
 * explicitly overridden and regenerate it from a second, independent AI
 * call once the real scan started -- producing different keyphrases than
 * the ones just reviewed. By explicit request, website scans now always run
 * the full, multi-page analysis before the review screen ever renders, so
 * the terms a user reviews are guaranteed to be the terms actually
 * searched, at the cost of the review screen taking as long as the full
 * analysis instead of a couple of seconds.
 *
 * These tests pin the invariants that keep that guarantee true and keep the
 * old fast tier from quietly creeping back in:
 *
 *  - the website understanding step crawls through the same SSRF/DNS-protected
 *    crawlWebsite() as everything else, with the full page budget, not a
 *    homepage-only one;
 *  - a website scan's persisted analysis is always "full" -- "fast" is never
 *    produced, and is therefore always safe to reuse verbatim;
 *  - stopAfterUnderstanding runs that full analysis synchronously and
 *    returns, rather than deferring the real analysis to a background job;
 *  - the removed fast-tier provider surface (analyzeBusinessFast,
 *    FastBusinessProfile, the fast schema) stays gone, so a future edit
 *    can't silently wire a fast path back in through the provider.
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");

const workflow = await read("../lib/server/scan-workflow.ts");
const providerContracts = await read("../lib/providers/contracts.ts");
const openaiProvider = await read("../lib/providers/openai.server.ts");
const serverContracts = await read("../lib/server/contracts.ts");
const termsRoute = await read("../app/api/scans/[scanId]/discovery-terms/route.ts");
const profileUi = await read("../components/DiscoveryProfile.tsx");
const experience = await read("../components/ThreadlineExperience.tsx");

test("the fast tier is fully gone: no runFastUnderstanding, refineDiscoveryProfile, or fast-analysis provider method remain", () => {
  for (const removed of [
    "async function runFastUnderstanding",
    "async function refineDiscoveryProfile",
    "function scanProfileFromFastAnalysis",
    "function businessUnderstandingFromFastAnalysis",
    "analyzeBusinessFast",
    "FastBusinessProfile",
    "FAST_BUSINESS_SCHEMA",
    "parseFastBusiness",
  ]) {
    assert.equal(workflow.includes(removed), false, `scan-workflow.ts must not reference ${removed}`);
    assert.equal(providerContracts.includes(removed), false, `providers/contracts.ts must not reference ${removed}`);
    assert.equal(openaiProvider.includes(removed), false, `openai.server.ts must not reference ${removed}`);
  }
});

test("website understanding crawls through the same SSRF-protected crawler, with the full page budget", () => {
  assert.match(workflow, /async function runFullWebsiteUnderstanding/);
  const fnStart = workflow.indexOf("async function runFullWebsiteUnderstanding");
  const fnBody = workflow.slice(fnStart, workflow.indexOf("\n/**", fnStart));
  assert.match(fnBody, /crawlWebsite\(scan\.websiteUrl, \{ maxPages: 4 \}\)/);
  assert.equal(/maxPages: 1/.test(fnBody), false, "the full understanding pass must not use the old homepage-only page budget");
  // No second, unprotected fetch/http/https import or call anywhere in this
  // file -- crawlWebsite is the only network entry point website analysis uses.
  assert.equal(/\bfetch\(/.test(workflow), false, "scan-workflow.ts must not fetch directly");
});

test("a website scan's persisted profileStage is always full, and is therefore always safe to reuse", () => {
  assert.match(workflow, /profileStage: "full"/);
  assert.match(workflow, /const canReusePersistedAnalysis = Boolean\(persistedAnalysis\);/);
  assert.match(workflow, /if \(canReusePersistedAnalysis && persistedAnalysis\) \{/);
});

test("stopAfterUnderstanding runs the full analysis synchronously and returns, with no background job fired", () => {
  const tryBlock = workflow.slice(workflow.indexOf("try {\n    await setStage(scan, \"website\", \"active\");"));
  const stopBranch = tryBlock.indexOf("if (options.stopAfterUnderstanding) {");
  const afterStopBranch = tryBlock.indexOf("\n    const models = openAiModelsFromEnv();", stopBranch);
  assert.ok(stopBranch > -1 && afterStopBranch > stopBranch, "expected the stopAfterUnderstanding branch in runScan");
  const stopBranchBody = tryBlock.slice(stopBranch, afterStopBranch);
  assert.match(stopBranchBody, /runFullWebsiteUnderstanding\(scan\)/);
  assert.match(stopBranchBody, /return scan;/);
  // No fire-and-forget background continuation left to race against.
  assert.equal(/void \w+\(/.test(stopBranchBody), false, "no background job should be fired from the understanding step anymore");
});

test("the review screen and its API still expose profileStage, always reporting full for a persisted analysis", () => {
  assert.match(termsRoute, /profileStage: analysis\?\.profileStage \?\? \(analysis \? "full" : null\)/);
  assert.match(profileUi, /profileStage\?: "fast" \| "full" \| null;/);
  assert.match(experience, /function RefiningProfile/);
  assert.match(experience, /payload\.profileStage === "full"/);
});

test("discoveryProfile's stored shape documents profileStage for future readers", () => {
  assert.match(serverContracts, /profileStage\?: "fast" \| "full";/);
});
