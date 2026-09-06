import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * A hallucinated-but-real domain can pass SSRF/public-URL validation, so
 * that check alone is not sufficient proof a resolved URL is the actual
 * competitor's site. These tests pin the invariants that keep this
 * feature from ever auto-filling an unverified guess, plus the final
 * adopted architecture after an A/B comparison (crawl-evidence-based
 * suggestion vs. the original BusinessUnderstanding-based one, across
 * several different business types) showed comparable-to-better results:
 * one combined name+URL request from compact crawl evidence, run
 * concurrently with analyzeBusiness right after the crawl (not
 * sequentially after it), with no dependency on BusinessUnderstanding or
 * CompetitorReference at all.
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");

const resolution = await read("../lib/server/competitor-url-resolution.ts");
const provider = await read("../lib/providers/openai.server.ts");
const contracts = await read("../lib/providers/contracts.ts");
const route = await read("../app/api/scans/[scanId]/competitor-url-suggestions/route.ts");
const setup = await read("../components/CompetitorsSetup.tsx");
const serverContracts = await read("../lib/server/contracts.ts");
const domainTypes = await read("../lib/domain/types.ts");
const workflow = await read("../lib/server/scan-workflow.ts");
const serverProgress = await read("../lib/server/scan-progress.ts");

test("competitor name and URL are proposed together in one request, not two sequential model calls", () => {
  assert.match(provider, /async suggestCompetitorsFromCrawl\(/);
  assert.doesNotMatch(provider, /async (?:generateCompetitorNames|suggestCompetitorNames)\(/);
  assert.match(resolution, /aiProvider\.suggestCompetitorsFromCrawl\(\{/);
});

test("suggestions are generated from compact crawl evidence, not from BusinessUnderstanding.competitors or a completed business profile", () => {
  assert.doesNotMatch(resolution, /business\.competitors\.value|competitorNames:|businessName:/);
  assert.doesNotMatch(route, /business\.competitors\.value|businessName: business\.name\.value,\s*\n\s*websiteUrl/);
  assert.match(route, /pages: buildCompactCompetitorEvidence\(crawl\)/);
});

test("the model proposal is never trusted alone -- every candidate is independently verified against its own homepage before being kept", () => {
  assert.match(resolution, /identityMatch\(name, \{/);
  assert.match(resolution, /diagnostic\.verified = matched;/);
});

test("an unverified candidate (bad URL or failed identity check) is dropped entirely, not shown as a partial/name-only suggestion", () => {
  assert.match(resolution, /\.filter\(\(\{ diagnostic \}\) => diagnostic\.verified\)/);
});

test("verification is a single lightweight homepage fetch (maxPages: 1), never the full multi-page competitor crawl, before the user continues", () => {
  assert.match(resolution, /crawlWebsite\(url, \{\s*maxPages: 1,/);
  assert.doesNotMatch(resolution, /crawlWebsite\([^)]*maxPages: 4/);
});

test("candidates are validated through the existing public-URL/SSRF check, rejected for matching the user's own domain, and deduplicated by hostname", () => {
  assert.match(resolution, /validatePublicWebsiteUrl\(withScheme, params\.resolver\)/);
  assert.match(resolution, /target\.canonicalHostname === params\.ownDomain/);
  assert.match(resolution, /seenHostnames\.has\(target\.canonicalHostname\)/);
});

test("a model-lookup failure degrades to no suggestions rather than throwing", () => {
  assert.match(resolution, /try \{\s*const result = await params\.aiProvider\.suggestCompetitorsFromCrawl/);
});

test("homepage verification fetches run in parallel across the batch, not sequentially", () => {
  assert.match(resolution, /await Promise\.all\(\s*candidates\.map/);
});

test("competitor suggestion uses the economy model and one batched request, not the analysis tier and not one request per candidate", () => {
  assert.match(provider, /model: request\.models\.economyModel,\s*\n\s*operation: "competitor_suggestion"/);
});

test("the model is explicitly told not to guess a domain from the name alone, and not to pad the list to reach 3", () => {
  const method = provider.slice(provider.indexOf("async suggestCompetitorsFromCrawl"), provider.indexOf("async suggestCompetitorsFromCrawl") + 3500);
  assert.match(method, /set url to null rather than guessing/i);
  assert.match(method, /never[\s\S]*?invent a domain by pattern-matching/i);
  assert.match(method, /do not pad[\s\S]*to reach 3/i);
});

test("the model is asked to consider geography for location-dependent businesses and product/audience similarity for online ones", () => {
  const method = provider.slice(provider.indexOf("async suggestCompetitorsFromCrawl"), provider.indexOf("async suggestCompetitorsFromCrawl") + 3500);
  assert.match(method, /location-dependent/i);
  assert.match(method, /online\/global/i);
});

test("this feature adds no new fields to BusinessUnderstanding or CompetitorReference", () => {
  const competitorReferenceStart = domainTypes.indexOf("export interface CompetitorReference");
  const competitorReferenceBody = domainTypes.slice(competitorReferenceStart, domainTypes.indexOf("}", competitorReferenceStart));
  assert.doesNotMatch(competitorReferenceBody, /\burl\b|\bdomain\b/i);
});

test("the suggestions cache lives on scan.competitorSuggestions, a top-level field separate from discoveryProfile", () => {
  assert.match(serverContracts, /competitorSuggestions\?:\s*\{\s*\n\s*status: "ready" \| "failed";\s*\n\s*suggestions: Record<string, string>;/);
  assert.doesNotMatch(serverContracts, /discoveryProfile\?: \{[\s\S]*competitorUrlSuggestions/);
});

test("the route serves from cache only when the branch is marked ready, instead of re-running the model+fetch pipeline", () => {
  assert.match(route, /if \(!debug && cached\?\.status === "ready"\)/);
});

test("only successfully-verified suggestions are written into the cache's suggestions map -- a scan with zero verified suggestions still marks the branch ready, just with nothing to show", () => {
  assert.match(route, /resolution\.suggestions\.length > 0/);
  assert.match(route, /suggestions: \{ \.\.\.cached\?\.suggestions, \.\.\.resolvedOnly \}/);
});

test("the route only requires the crawl, not a completed business profile, to serve or compute suggestions", () => {
  assert.doesNotMatch(route, /const business = scan\.discoveryProfile\?\.business;\s*\n\s*if \(!business/);
  assert.match(route, /if \(!crawl\)/);
});

test("the route is its own endpoint, not a field bolted onto the shared discovery-terms route DiscoveryProfile.tsx also polls for unrelated data", () => {
  assert.doesNotMatch(route, /from ["']@\/app\/api\/scans\/\[scanId\]\/discovery-terms|fetch\([^)]*discovery-terms/);
});

test("CompetitorsSetup pre-fills the bare domain (via the existing cleanDomain helper), matching the input's own https:// prefix element, not a full URL with scheme", () => {
  assert.match(setup, /url: cleanDomain\(url\)/);
});

test("suggested URLs remain a normal editable input value, not a locked/disabled field", () => {
  const inputBlock = setup.slice(setup.indexOf("<input"), setup.indexOf("<input") + 300);
  assert.doesNotMatch(inputBlock, /disabled|readOnly/);
  assert.match(inputBlock, /onChange=\{\(event\) => updateRowUrl/);
});

test("no new external search/AI provider was introduced -- the new AiProvider method is implemented on the existing OpenAiProvider class", () => {
  assert.doesNotMatch(resolution, /perplexity|serpapi|bing|google.*search.*api/i);
  assert.match(contracts, /suggestCompetitorsFromCrawl\(/);
});

test("instrumentation covers model latency, candidates returned, verification latency, and verified count", () => {
  assert.match(resolution, /modelLookupMs, candidatesReturned: proposed\.length, verificationMs, verifiedCount: suggestions\.length, totalMs/);
});

test("resolveCompetitorUrlsFromCrawl has no dependency on BusinessUnderstanding -- it only takes websiteUrl/canonicalDomain/pages", () => {
  const fnStart = resolution.indexOf("export async function resolveCompetitorUrlsFromCrawl");
  const fnBody = resolution.slice(fnStart, resolution.indexOf("\n}\n", fnStart));
  assert.doesNotMatch(fnBody, /business\.|BusinessUnderstanding|businessName:/);
  assert.match(fnBody, /aiProvider\.suggestCompetitorsFromCrawl\(/);
});

test("compact evidence is capped well below what analyzeBusiness receives, per page", () => {
  assert.match(resolution, /MAX_TEXT_EXCERPT_CHARS = 600/);
  assert.match(resolution, /MAX_EVIDENCE_PAGES = 4/);
  assert.match(resolution, /textExcerpt: page\.text\.slice\(0, MAX_TEXT_EXCERPT_CHARS\)/);
});

test("there is exactly one acquisition path left -- the old BusinessUnderstanding-based one and the A/B comparison mode were removed once the new path was adopted", () => {
  assert.doesNotMatch(resolution, /export async function resolveCompetitorUrls\(/);
  assert.doesNotMatch(provider, /async suggestCompetitors\(/);
  assert.doesNotMatch(contracts, /suggestCompetitors\(/);
  assert.doesNotMatch(route, /compareSuggestionSource/);
});

test("analyzeBusiness and competitor suggestion run concurrently right after the crawl, not sequentially", () => {
  const fnStart = workflow.indexOf("async function runFullWebsiteUnderstanding");
  const fnBody = workflow.slice(fnStart, workflow.indexOf("\n}\n", fnStart));
  assert.match(fnBody, /await Promise\.allSettled\(\[/);
  assert.match(fnBody, /aiProvider\.analyzeBusiness\(\{/);
  assert.match(fnBody, /resolveCompetitorUrlsFromCrawl\(\{/);
});

test("a competitor-suggestion failure never fails the analyzeBusiness retry loop -- allSettled, not all -- and is still marked settled (never left permanently pending)", () => {
  const fnStart = workflow.indexOf("async function runFullWebsiteUnderstanding");
  const fnBody = workflow.slice(fnStart, workflow.indexOf("\n}\n", fnStart));
  assert.match(fnBody, /scan\.competitorSuggestions = \{ status: "failed", suggestions: \{\}, readyAt: new Date\(\)\.toISOString\(\) \};/);
  assert.match(fnBody, /if \(analyzedOutcome\.status === "rejected"\) throw analyzedOutcome\.reason;/);
});

test("competitor suggestions are persisted the moment that branch settles, independent of analyzeBusiness -- not written onto discoveryProfile, and not left for the Competitors screen's own round-trip", () => {
  assert.match(workflow, /scan\.competitorSuggestions = \{\s*\n\s*status: "ready",/);
  assert.match(workflow, /await persistScan\(scan\);\s*\n\s*return result;/);
  assert.doesNotMatch(workflow, /discoveryProfile = \{[\s\S]{0,300}competitorSuggestions/);
});

test("a failed competitor branch still unblocks entry into the Competitors screen -- competitorsReady means the branch settled, not that it succeeded", () => {
  assert.match(serverProgress, /competitorsReady: !!scan\.competitorSuggestions,/);
  assert.doesNotMatch(serverProgress, /competitorsReady:.*status === "ready"[^|]*$/m);
});
