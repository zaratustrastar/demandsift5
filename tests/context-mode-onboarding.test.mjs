import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * "Describe your market / idea" is a second source for the same
 * BusinessUnderstanding a website crawl already produces -- never a
 * separate pipeline. These tests pin the invariants that keep it that way:
 *
 *  - a context-mode scan never fabricates a website or domain (empty
 *    string, never a guessed one);
 *  - runScan branches only at the understanding step -- competitor setup,
 *    query generation, Reddit discovery, triage, ranking, insights and
 *    monitoring are reached through the exact same code for both sources;
 *  - competitors are never required to run a scan, in either mode;
 *  - a competitor the user explicitly names is tagged distinctly from one
 *    the model only suggests, and only the explicit (or user-confirmed) one
 *    can drive a dedicated Reddit search lane.
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");

const domainTypes = await read("../lib/domain/types.ts");
const serverContracts = await read("../lib/server/contracts.ts");
const providerContracts = await read("../lib/providers/contracts.ts");
const openaiProvider = await read("../lib/providers/openai.server.ts");
const scanWorkflow = await read("../lib/server/scan-workflow.ts");
const scansRoute = await read("../app/api/scans/route.ts");
const discoveryTermsRoute = await read("../app/api/scans/[scanId]/discovery-terms/route.ts");
const presenter = await read("../lib/server/presenter.ts");
const replyService = await read("../lib/server/reply-service.ts");
const fromScan = await read("../components/demand-intelligence/from-scan.ts");
const competitorsSetup = await read("../components/CompetitorsSetup.tsx");
const discoveryProfile = await read("../components/DiscoveryProfile.tsx");
const threadlineExperience = await read("../components/ThreadlineExperience.tsx");
const schema = await read("../db/postgres/schema.ts");
const migration = await read("../db/migrations/0008_context_mode_onboarding.sql");

test("BusinessUnderstanding and CompetitorReference model both onboarding sources", () => {
  assert.match(
    domainTypes,
    /websiteUrl: string;/,
    "websiteUrl stays a plain string -- empty for context mode, never a fabricated domain",
  );
  assert.match(
    domainTypes,
    /"website_claim" \| "external_provider" \| "unverified_hypothesis" \| "user_claim"/,
    "user_claim distinguishes a competitor the user explicitly named from an AI suggestion",
  );
});

test("ScanRecord tracks inputMode/contextText without requiring a schema change", () => {
  assert.match(serverContracts, /inputMode\?: "website" \| "context";/);
  assert.match(serverContracts, /contextText\?: string \| null;/);
  assert.match(
    serverContracts,
    /kind: "website" \| "reddit" \| "user_supplied";/,
    "Provenance.kind must accept the freeform-text source",
  );
});

test("createScan accepts either a website or context input, never a fabricated domain", () => {
  assert.match(scanWorkflow, /export type CreateScanInput =/);
  assert.match(scanWorkflow, /\{ websiteUrl: string \}/);
  assert.match(scanWorkflow, /\{ contextText: string \}/);
  const fn = scanWorkflow.slice(scanWorkflow.indexOf("export async function createScan"));
  const body = fn.slice(0, fn.indexOf("\nexport async function enqueueScanRun"));
  assert.match(body, /websiteUrl: isContext \? "" : input\.websiteUrl/);
  assert.match(body, /inputMode: isContext \? "context" : "website"/);
});

test("AiProvider gains a context-mode counterpart to analyzeBusiness, not a parallel pipeline", () => {
  assert.match(providerContracts, /analyzeBusinessFromContext\(/);
  // Same output type as the website path -- both produce BusinessUnderstanding.
  const ifaceStart = providerContracts.indexOf("export interface AiProvider {");
  const iface = providerContracts.slice(ifaceStart, providerContracts.indexOf("\n}", ifaceStart));
  assert.match(iface, /analyzeBusinessFromContext[\s\S]*?Promise<AiProviderResult<BusinessUnderstanding>>/);
});

test("analyzeBusinessFromContext reuses parseBusiness -- same parsing/validation path as the website source", () => {
  assert.match(openaiProvider, /async analyzeBusinessFromContext\(/);
  const fnStart = openaiProvider.indexOf("async analyzeBusinessFromContext(");
  const fnBody = openaiProvider.slice(fnStart, openaiProvider.indexOf("\n  }\n", fnStart));
  assert.match(fnBody, /parse: \(value\) => parseBusiness\(value, asWebsiteRequest, generatedAt\)/);
  assert.match(fnBody, /websiteUrl: ""/);
  assert.match(fnBody, /canonicalDomain: ""/);
  assert.match(fnBody, /model: request\.models\.analysisModel/);
});

test("the context-mode prompt asks for explicit vs suggested competitors with distinct verification tags", () => {
  const fnStart = openaiProvider.indexOf("async analyzeBusinessFromContext(");
  const fnBody = openaiProvider.slice(fnStart, openaiProvider.indexOf("\n  }\n", fnStart));
  assert.match(fnBody, /verification=\\"user_claim\\"/);
  assert.match(fnBody, /verification=\\"unverified_hypothesis\\"/);
  assert.match(fnBody, /omit it rather than guess/);
});

test("the competitor verification enum and its validator both accept user_claim", () => {
  assert.match(
    openaiProvider,
    /enum: \["website_claim", "external_provider", "unverified_hypothesis", "user_claim"\]/,
  );
  assert.match(
    openaiProvider,
    /"website_claim", "external_provider", "unverified_hypothesis", "user_claim",/,
  );
});

test("runScan branches only at the understanding step -- everything after is unconditional", () => {
  const runScanStart = scanWorkflow.indexOf("export async function runScan(");
  const runScanBody = scanWorkflow.slice(runScanStart, scanWorkflow.indexOf("\nexport async function", runScanStart + 10));

  assert.match(runScanBody, /scan\.inputMode === "context"/);
  assert.match(runScanBody, /runContextUnderstanding\(scan\)/);
  assert.match(runScanBody, /crawlWebsite\(scan\.websiteUrl/);

  // Query planning, Reddit discovery, triage, ranking, insights and
  // monitoring must never re-branch on inputMode -- only the understanding
  // step (crawl vs. context) does.
  const afterUnderstanding = runScanBody.slice(runScanBody.indexOf("applyDiscoveryOverrides(business"));
  assert.equal(
    /inputMode/.test(afterUnderstanding),
    false,
    "nothing after query planning should branch on inputMode -- the pipeline is shared",
  );
});

test("context mode never crawls a website", () => {
  const fnStart = scanWorkflow.indexOf("async function runContextUnderstanding(");
  const fnBody = scanWorkflow.slice(fnStart, scanWorkflow.indexOf("\n}\n", fnStart));
  assert.equal(/crawlWebsite/.test(fnBody), false);
  assert.match(fnBody, /analyzeBusinessFromContext/);
  assert.match(fnBody, /conservativeProfileFromContext/, "the no-AI-configured fallback stays context-shaped too");
});

test("the fast/refine split (website-only) is never triggered for context scans", () => {
  const stopAfterIndex = scanWorkflow.indexOf("if (options.stopAfterUnderstanding) {");
  const stopAfterBlock = scanWorkflow.slice(stopAfterIndex, scanWorkflow.indexOf("\n    const crawl = await crawlWebsite(scan.websiteUrl, { maxPages: 4 });"));
  assert.match(stopAfterBlock, /if \(scan\.inputMode === "context"\) \{/);
  assert.match(stopAfterBlock, /profileStage: "full"/);
  // refineDiscoveryProfile (the background website refine) must appear only
  // in the website branch, i.e. after the context branch's early return.
  const contextBranchEnd = stopAfterBlock.indexOf("return scan;\n      }");
  const websiteBranch = stopAfterBlock.slice(contextBranchEnd);
  assert.match(websiteBranch, /refineDiscoveryProfile\(scan\.id\)/);
});

test("the context source id is deterministic per scan, so reused citations stay valid", () => {
  assert.match(scanWorkflow, /id: `ctx_\$\{scanId\}`/);
});

test("POST \\/api\\/scans accepts contextText as an alternative to websiteUrl, with length bounds", () => {
  assert.match(scansRoute, /contextText\?: unknown;/);
  assert.match(scansRoute, /MIN_CONTEXT_TEXT_LENGTH/);
  assert.match(scansRoute, /MAX_CONTEXT_TEXT_LENGTH/);
  assert.match(scansRoute, /scanInput = \{ contextText: contextCandidate \};/);
});

test("the discovery-terms GET response splits named competitors into explicit vs suggested", () => {
  assert.match(discoveryTermsRoute, /competitorSuggestions:/);
  assert.match(discoveryTermsRoute, /"suggested" as const/);
  assert.match(discoveryTermsRoute, /"explicit" as const/);
  assert.match(discoveryTermsRoute, /competitor\.verification === "unverified_hypothesis"/);
});

test("presentScan exposes inputMode/contextText for both the pre-result and completed shapes", () => {
  const occurrences = presenter.match(/inputMode: scan\.inputMode \?\? "website"/g) ?? [];
  assert.equal(occurrences.length, 2, "both presentScan return branches must expose inputMode");
});

test("reply generation never claims a public site exists for a context-mode business", () => {
  assert.match(replyService, /function hostnameOrEmpty/);
  assert.match(replyService, /profile\.websiteUrl\s*\n?\s*\? `Its public site describes/);
  assert.match(replyService, /Here is what's relevant/);
});

test("provenance rendering treats user_supplied as its own kind, never as a Reddit conversation", () => {
  assert.match(fromScan, /kind: "website" \| "reddit" \| "user_supplied";/);
  assert.match(fromScan, /source\.kind === "user_supplied"\s*\n?\s*\? "user-action"/);
  assert.match(fromScan, /"Business context you provided"/);
});

test("the Competitors & alternatives step never requires competitors", () => {
  assert.match(competitorsSetup, /Competitors & alternatives/);
  assert.match(competitorsSetup, /className=\{styles\.skipLink\} type="button" onClick=\{onContinue\}/);
  // Skip must not be gated on any competitor state.
  const footerStart = competitorsSetup.indexOf("<footer");
  const footer = competitorsSetup.slice(footerStart, competitorsSetup.indexOf("</footer>"));
  assert.equal(/skipLink[\s\S]*?disabled=\{saving \|\|/.test(footer), false, "Skip must only ever be disabled by the save-in-flight state, same as before");
});

test("context mode shows an editable, never-required competitor suggestion list with an empty state", () => {
  assert.match(competitorsSetup, /isContextMode = !websiteUrl/);
  assert.match(competitorsSetup, /No competitors added yet\./);
  assert.match(competitorsSetup, /didn't find a clear competitor in your description/);
  assert.match(competitorsSetup, /addNamedCompetitor/);
  assert.match(competitorsSetup, /removeNamedCompetitor/);
});

test("the discovery profile screen's competitors field is relabeled consistently", () => {
  assert.match(discoveryProfile, /label: "Competitors & alternatives"/);
});

test("the landing page offers Website and Describe your market / idea as equal tabs, website default", () => {
  assert.match(threadlineExperience, />\s*Website\s*<\/button>/);
  assert.match(threadlineExperience, /Describe your market \/ idea/);
  assert.match(threadlineExperience, /useState<"website" \| "context">\("website"\)/);
});

test("the context textarea path posts contextText, not a fabricated websiteUrl", () => {
  assert.match(threadlineExperience, /inputMode === "context" \? \{ contextText, \.\.\.extra \} : \{ websiteUrl: url, \.\.\.extra \}/);
});

test("continuous monitoring's website constraint is relaxed for context-mode businesses, not removed as a column", () => {
  assert.match(migration, /DROP CONSTRAINT IF EXISTS runtime_monitoring_schedules_website_check/);
  assert.match(schema, /websiteUrl: text\("website_url"\)\.notNull\(\)/);
  assert.equal(
    /runtime_monitoring_schedules_website_check/.test(schema),
    false,
    "the check() call for the dropped constraint must not still be declared in the Drizzle schema",
  );
});
