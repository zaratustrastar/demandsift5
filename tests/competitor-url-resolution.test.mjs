import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * A hallucinated-but-real domain can pass SSRF/public-URL validation, so
 * that check alone is not sufficient proof a resolved URL is the actual
 * competitor's site. These tests pin the invariants that keep this feature
 * from ever auto-filling an unverified guess: the model is never trusted
 * alone, every candidate is independently checked against its own
 * homepage's stated identity, and only genuinely small/reused
 * infrastructure is involved -- no new external provider, no full
 * multi-page crawl before the user continues, no change to
 * BusinessUnderstanding or CompetitorReference.
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");

const resolution = await read("../lib/server/competitor-url-resolution.ts");
const provider = await read("../lib/providers/openai.server.ts");
const contracts = await read("../lib/providers/contracts.ts");
const route = await read("../app/api/scans/[scanId]/competitor-url-suggestions/route.ts");
const setup = await read("../components/CompetitorsSetup.tsx");
const serverContracts = await read("../lib/server/contracts.ts");
const domainTypes = await read("../lib/domain/types.ts");

test("the model proposal is never trusted alone -- every candidate is independently verified against its own homepage before being kept", () => {
  assert.match(resolution, /identityMatches\(candidate\.name, identityText\)/);
  // The homepage fetch happens after -- not instead of -- validating the
  // URL, and the final suggestion list is built from the *verified* set,
  // not the raw model proposal.
  assert.match(resolution, /const verifiedByName = new Map/);
  assert.doesNotMatch(
    resolution,
    /suggestions = names\.map\(\(name\) => \(\{ name, url: proposedByName/,
    "the final suggestions must come from verifiedByName, not the raw unverified model proposal",
  );
});

test("verification is a single lightweight homepage fetch (maxPages: 1), never the full multi-page competitor crawl, before the user continues", () => {
  assert.match(resolution, /crawlWebsite\(candidate\.url, \{\s*maxPages: 1,/);
  assert.doesNotMatch(resolution, /crawlWebsite\(candidate\.url, \{\s*maxPages: 4/);
});

test("candidates are validated through the existing public-URL/SSRF check, rejected for matching the user's own domain, and deduplicated by hostname", () => {
  assert.match(resolution, /validatePublicWebsiteUrl\(withScheme, params\.resolver\)/);
  assert.match(resolution, /target\.canonicalHostname === params\.ownDomain/);
  assert.match(resolution, /seenHostnames\.has\(target\.canonicalHostname\)/);
});

test("a model-lookup failure degrades to no suggestions rather than throwing -- the Competitors screen must still render with empty, editable fields", () => {
  assert.match(resolution, /try \{\s*const proposed = await params\.aiProvider\.resolveCompetitorDomains/);
});

test("homepage verification fetches run in parallel across the batch, not sequentially", () => {
  assert.match(resolution, /await Promise\.all\(\s*candidates\.map/);
});

test("domain resolution uses the economy model and one batched request, not the analysis tier and not one request per name", () => {
  assert.match(provider, /model: request\.models\.economyModel,\s*\n\s*operation: "competitor_url_resolution"/);
  assert.doesNotMatch(
    provider.slice(provider.indexOf("async resolveCompetitorDomains")),
    /for \(.*competitorNames/s,
  );
});

test("the model is explicitly told not to guess a domain from the name alone", () => {
  const method = provider.slice(provider.indexOf("async resolveCompetitorDomains"), provider.indexOf("async resolveCompetitorDomains") + 3000);
  assert.match(method, /never guess|not.*confident.*null|null rather than guess/i);
  assert.match(method, /never invent a\s*"?\s*\+?\s*"?\s*domain by pattern-matching/i);
});

test("this feature adds no new fields to BusinessUnderstanding or CompetitorReference", () => {
  // CompetitorReference already existed before this feature; it must still
  // have no url/domain field -- resolution is a separate sidecar, not a
  // redesign of the AI-derived competitor shape.
  const competitorReferenceStart = domainTypes.indexOf("export interface CompetitorReference");
  const competitorReferenceBody = domainTypes.slice(competitorReferenceStart, domainTypes.indexOf("}", competitorReferenceStart));
  assert.doesNotMatch(competitorReferenceBody, /\burl\b|\bdomain\b/i);
});

test("the suggestions cache lives on discoveryProfile, keyed by name, distinguishing 'resolved to nothing' from 'never attempted'", () => {
  assert.match(serverContracts, /competitorUrlSuggestions\?:\s*Record<string, string \| null>/);
});

test("the route serves from cache when every current competitor name already has an entry, instead of re-running the model+fetch pipeline", () => {
  assert.match(route, /if \(cached && names\.every\(\(name\) => name in cached\)\)/);
});

test("the route is its own endpoint, not a field bolted onto the shared discovery-terms route DiscoveryProfile.tsx also polls for unrelated data", () => {
  // The route's own doc comment explains *why* (mentioning discovery-terms
  // by name is expected there) -- what must not exist is an actual import
  // of or fetch to that route.
  assert.doesNotMatch(route, /from ["']@\/app\/api\/scans\/\[scanId\]\/discovery-terms|fetch\([^)]*discovery-terms/);
});

test("CompetitorsSetup pre-fills the bare domain (via the existing cleanDomain helper), matching the input's own https:// prefix element, not a full URL with scheme", () => {
  assert.match(setup, /url: url \? cleanDomain\(url\) : ""/);
});

test("suggested URLs remain a normal editable input value, not a locked/disabled field", () => {
  const inputBlock = setup.slice(setup.indexOf("<input"), setup.indexOf("<input") + 300);
  assert.doesNotMatch(inputBlock, /disabled|readOnly/);
  assert.match(inputBlock, /onChange=\{\(event\) => updateRowUrl/);
});

test("no new external search/AI provider was introduced -- the new AiProvider method is implemented on the existing OpenAiProvider class", () => {
  assert.doesNotMatch(resolution, /perplexity|serpapi|bing|google.*search.*api/i);
  assert.match(contracts, /resolveCompetitorDomains\(/);
});
