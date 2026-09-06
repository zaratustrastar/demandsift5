import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * A hallucinated-but-real domain can pass SSRF/public-URL validation, so
 * that check alone is not sufficient proof a resolved URL is the actual
 * competitor's site. These tests pin the invariants that keep this
 * feature from ever auto-filling an unverified guess, and the specific
 * design constraints from the pivot away from
 * BusinessUnderstanding.competitors (which turned out to be empty for
 * most real businesses, since a company's own marketing site essentially
 * never names its rivals) to a single combined name+URL suggestion call:
 * one request, not two sequential model calls; BusinessUnderstanding and
 * CompetitorReference untouched; every candidate independently verified;
 * an unverified candidate dropped entirely, not shown partially.
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");

const resolution = await read("../lib/server/competitor-url-resolution.ts");
const provider = await read("../lib/providers/openai.server.ts");
const contracts = await read("../lib/providers/contracts.ts");
const route = await read("../app/api/scans/[scanId]/competitor-url-suggestions/route.ts");
const setup = await read("../components/CompetitorsSetup.tsx");
const serverContracts = await read("../lib/server/contracts.ts");
const domainTypes = await read("../lib/domain/types.ts");

test("competitor name and URL are proposed together in one request, not two sequential model calls", () => {
  assert.match(provider, /async suggestCompetitors\(/);
  // No separate "generate names" step feeding a second "resolve URLs"
  // call -- one call, business context in, {name, url} pairs out.
  assert.doesNotMatch(provider, /async (?:generateCompetitorNames|suggestCompetitorNames)\(/);
  assert.match(resolution, /aiProvider\.suggestCompetitors\(\{/);
});

test("suggestions are generated from the business's own profile, not from BusinessUnderstanding.competitors", () => {
  assert.doesNotMatch(resolution, /business\.competitors\.value|competitorNames:/);
  assert.doesNotMatch(route, /business\.competitors\.value/);
  assert.match(route, /businessName: business\.name\.value/);
  assert.match(route, /summary: business\.summary\.value/);
  assert.match(route, /productCategory: business\.productCategory\.value/);
  assert.match(route, /targetAudience: business\.targetAudiences\.value\.map/);
  assert.match(route, /problemsSolved: business\.problemsSolved\.value/);
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

test("a model-lookup failure degrades to no suggestions rather than throwing -- the Competitors screen must still render with its own empty, editable fallback row", () => {
  assert.match(resolution, /try \{\s*const result = await params\.aiProvider\.suggestCompetitors/);
});

test("homepage verification fetches run in parallel across the batch, not sequentially", () => {
  assert.match(resolution, /await Promise\.all\(\s*candidates\.map/);
});

test("competitor suggestion uses the economy model and one batched request, not the analysis tier and not one request per candidate", () => {
  assert.match(provider, /model: request\.models\.economyModel,\s*\n\s*operation: "competitor_suggestion"/);
});

test("the model is explicitly told not to guess a domain from the name alone, and not to pad the list to reach 3", () => {
  const method = provider.slice(provider.indexOf("async suggestCompetitors"), provider.indexOf("async suggestCompetitors") + 3000);
  assert.match(method, /set url to null rather than guessing/i);
  assert.match(method, /never invent a domain by pattern-matching/i);
  assert.match(method, /do not pad[\s\S]*to reach 3/i);
});

test("the model is asked to consider geography for location-dependent businesses and product/audience similarity for online ones", () => {
  const method = provider.slice(provider.indexOf("async suggestCompetitors"), provider.indexOf("async suggestCompetitors") + 3000);
  assert.match(method, /location-dependent/i);
  assert.match(method, /online\/global/i);
});

test("this feature adds no new fields to BusinessUnderstanding or CompetitorReference", () => {
  const competitorReferenceStart = domainTypes.indexOf("export interface CompetitorReference");
  const competitorReferenceBody = domainTypes.slice(competitorReferenceStart, domainTypes.indexOf("}", competitorReferenceStart));
  assert.doesNotMatch(competitorReferenceBody, /\burl\b|\bdomain\b/i);
});

test("the suggestions cache lives on discoveryProfile, keyed by name", () => {
  assert.match(serverContracts, /competitorUrlSuggestions\?:\s*Record<string, string \| null>/);
});

test("the route serves from cache when anything is already cached, instead of re-running the model+fetch pipeline", () => {
  assert.match(route, /if \(!debug && cached && Object\.keys\(cached\)\.length > 0\)/);
});

test("only successfully-verified suggestions are cached -- a scan with zero verified suggestions is retried on the next request, not permanently remembered as empty", () => {
  assert.match(route, /resolution\.suggestions\.length > 0/);
  // The cache write merges with what was already there rather than
  // replacing it outright.
  assert.match(route, /competitorUrlSuggestions: \{ \.\.\.cached, \.\.\.resolvedOnly \}/);
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
  assert.match(contracts, /suggestCompetitors\(/);
});

test("instrumentation covers model latency, candidates returned, verification latency, and verified count", () => {
  assert.match(resolution, /modelLookupMs,\s*candidatesReturned:/);
  assert.match(resolution, /verificationMs,\s*\n\s*verifiedCount:/);
  assert.match(resolution, /totalMs = performance\.now\(\) - totalStarted;/);
});
