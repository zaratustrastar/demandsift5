import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * The fast first-pass profile only makes the setup screen feel instant
 * without also making Reddit discovery worse if a handful of invariants
 * hold together:
 *
 *  - the fast pass reads the homepage through the same SSRF/DNS-protected
 *    crawlWebsite() as everything else, just with maxPages: 1 -- it must
 *    never bypass that protection with a separate fetch path;
 *  - a "fast" profileStage is never treated as good enough to plan Reddit
 *    queries from -- the full pipeline always redoes the full analysis
 *    first, whether or not the background refinement won the race;
 *  - the background refinement never clobbers a scan that has moved on
 *    (started, or already upgraded) while it was in flight;
 *  - the background refinement is truly fire-and-forget, so /analyze never
 *    waits on it.
 *
 * Any one of these regressing silently reintroduces either the original
 * 1-2 minute wait, or a scan that searches Reddit from a thin, unverified
 * homepage-only understanding of the business.
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");

const workflow = await read("../lib/server/scan-workflow.ts");
const providerContracts = await read("../lib/providers/contracts.ts");
const openaiProvider = await read("../lib/providers/openai.server.ts");
const serverContracts = await read("../lib/server/contracts.ts");
const termsRoute = await read("../app/api/scans/[scanId]/discovery-terms/route.ts");
const profileUi = await read("../components/DiscoveryProfile.tsx");

test("the fast pass crawls through the same SSRF-protected crawler, homepage only", () => {
  assert.match(workflow, /async function runFastUnderstanding/);
  const fastFn = workflow.slice(workflow.indexOf("async function runFastUnderstanding"));
  const fastFnBody = fastFn.slice(0, fastFn.indexOf("\nasync function refineDiscoveryProfile"));
  assert.match(fastFnBody, /crawlWebsite\(scan\.websiteUrl, \{ maxPages: 1/);
  // No second, unprotected fetch/http/https import or call anywhere in this
  // file -- crawlWebsite is the only network entry point website analysis uses.
  assert.equal(/\bfetch\(/.test(workflow), false, "scan-workflow.ts must not fetch directly");
});

test("a fast profileStage is persisted, never treated as a complete analysis", () => {
  assert.match(workflow, /profileStage: "fast"/);
  assert.match(workflow, /const canReusePersistedAnalysis =\s*\n?\s*Boolean\(persistedAnalysis\) && persistedAnalysis\?\.profileStage !== "fast";/);
  assert.match(workflow, /if \(canReusePersistedAnalysis && persistedAnalysis\) \{/);
  // Both places a full analysis is saved must explicitly mark it "full",
  // so a stale "fast" flag can never survive an upgrade.
  const fullSaves = workflow.match(/profileStage: "full"/g) ?? [];
  assert.ok(fullSaves.length >= 2, "expected profileStage: \"full\" at both the main-pipeline save and refineDiscoveryProfile");
});

test("stopAfterUnderstanding always takes the fast path and returns before the 4-page crawl", () => {
  const tryBlock = workflow.slice(workflow.indexOf("try {\n    await setStage(scan, \"website\", \"active\");"));
  const fastBranch = tryBlock.indexOf("if (options.stopAfterUnderstanding) {");
  const fullCrawl = tryBlock.indexOf('crawlWebsite(scan.websiteUrl, { maxPages: 4 });');
  assert.ok(fastBranch > -1 && fullCrawl > -1, "expected both the fast branch and the full crawl in runScan");
  assert.ok(fastBranch < fullCrawl, "the fast branch must be checked before the full 4-page crawl runs");
  const fastBranchBody = tryBlock.slice(fastBranch, fullCrawl);
  assert.match(fastBranchBody, /return scan;/);
});

test("background refinement is fire-and-forget and never blocks the fast return", () => {
  assert.match(workflow, /void refineDiscoveryProfile\(scan\.id\)\.catch\(/);
  const callSite = workflow.indexOf("void refineDiscoveryProfile(scan.id).catch(");
  const fastReturn = workflow.indexOf("return scan;", callSite);
  assert.ok(fastReturn > callSite, "the fast path must return after firing the background refinement, not await it");
});

test("background refinement re-reads the scan before writing, so it cannot clobber a scan that moved on", () => {
  assert.match(workflow, /async function refineDiscoveryProfile/);
  const fn = workflow.slice(workflow.indexOf("async function refineDiscoveryProfile"));
  const body = fn.slice(0, fn.indexOf("\nfunction usageRecord"));
  const getScanCalls = [...body.matchAll(/repository\.getScan\(scanId\)/g)];
  assert.equal(getScanCalls.length, 2, "expected an initial guard read and a pre-write re-read");
  const saveCall = body.indexOf("await repository.saveScan(latest);");
  const secondRead = body.lastIndexOf("repository.getScan(scanId)");
  assert.ok(secondRead < saveCall, "the re-read must happen before the write");
  assert.match(body, /latest\.status !== "queued" \|\| latest\.discoveryProfile\?\.profileStage !== "fast"\) return;/);
});

test("analyzeBusinessFast is on the provider contract and uses the economy model", () => {
  assert.match(providerContracts, /analyzeBusinessFast\(/);
  assert.match(providerContracts, /interface FastBusinessProfile/);
  assert.match(openaiProvider, /async analyzeBusinessFast\(request: AnalyzeBusinessRequest\)/);
  const fn = openaiProvider.slice(openaiProvider.indexOf("async analyzeBusinessFast"));
  const body = fn.slice(0, fn.indexOf("\n\n  "));
  assert.match(body, /model: request\.models\.economyModel/);
  assert.match(body, /reasoningEffort: "low"/);
});

test("the review screen and its API expose profileStage without disturbing existing fields", () => {
  assert.match(termsRoute, /profileStage: analysis\?\.profileStage \?\? \(analysis \? "full" : null\)/);
  assert.match(profileUi, /profileStage\?: "fast" \| "full" \| null;/);
  assert.match(profileUi, /if \(data\?\.profileStage !== "fast" \|\| edited\) return;/);
});

test("the fast-profile schema never leaks Boolean search syntax either", () => {
  assert.match(openaiProvider, /FAST_BUSINESS_SCHEMA/);
  const schemaStart = openaiProvider.indexOf("const FAST_BUSINESS_SCHEMA");
  const schemaEnd = openaiProvider.indexOf("const TRIAGE_SCHEMA");
  const schemaSection = openaiProvider.slice(schemaStart, schemaEnd);
  for (const token of ["AND", "OR", "NOT"]) {
    assert.equal(
      new RegExp('"[^"]*\\b' + token + '\\b[^"]*"').test(schemaSection),
      false,
      `the fast schema section must not reference Boolean token ${token}`,
    );
  }
});

test("discoveryProfile's stored shape documents profileStage for future readers", () => {
  assert.match(serverContracts, /profileStage\?: "fast" \| "full";/);
});
