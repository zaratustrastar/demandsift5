import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Competitor website analysis is a sidecar: it must reuse the existing
 * SSRF-protected crawler and the existing fast-pass AI schema (not invent a
 * second unprotected fetch or a second AI call), it must never be able to
 * masquerade as facts about the user's own business, and its output must
 * only ever supplement -- never precede or replace -- the primary
 * business's own Reddit query terms. Any one of those regressing either
 * reopens an SSRF gap on a URL nobody has reviewed as carefully as the
 * primary business's website, or quietly lets a competitor's homepage
 * claims leak into the scan's own business understanding.
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");

const analysis = await read("../lib/server/competitor-analysis.ts");
const analyzeRoute = await read("../app/api/competitors/analyze/route.ts");
const editRoute = await read("../app/api/competitors/route.ts");
const workflow = await read("../lib/server/scan-workflow.ts");
const contracts = await read("../lib/server/contracts.ts");
const termsRoute = await read("../app/api/scans/[scanId]/discovery-terms/route.ts");
const profileUi = await read("../components/DiscoveryProfile.tsx");

test("competitor sites go through the same SSRF-protected crawler, same multi-page budget as the primary business", () => {
  assert.match(analysis, /crawlWebsite\(url, \{ maxPages: 4/);
  assert.equal(/\bfetch\(/.test(analysis), false, "competitor-analysis.ts must not fetch directly");
});

test("competitor sites reuse the existing full-analysis AI schema, not a new one -- by explicit request, the same quality as the primary business's own profile, not the cheap preview tier", () => {
  assert.match(analysis, /aiProvider\.analyzeBusiness\(/);
  assert.equal(/aiProvider\.analyzeBusinessFast\(/.test(analysis), false,
    "competitor analysis must use the full model, not the fast/preview tier");
  assert.equal(
    /FAST_BUSINESS_SCHEMA|BUSINESS_SCHEMA/.test(analysis),
    false,
    "competitor-analysis.ts must not define or reference a schema of its own",
  );
});

test("each competitor URL is analyzed independently so one failure never sinks the batch", () => {
  assert.match(analysis, /Promise\.all\(urls\.map/);
  assert.match(analysis, /status: "failed"/);
  assert.match(analysis, /export const MAX_COMPETITOR_URLS = 3;/);
});

test("CompetitorProfile is a distinct model, never folded into the business's own understanding", () => {
  assert.match(contracts, /export type CompetitorProfile = \{/);
  assert.match(contracts, /competitorProfiles\?: CompetitorProfile\[\] \| null;/);
  // The primary business's own analysis pipeline (runFullWebsiteUnderstanding,
  // the same full analyzeBusiness call competitor analysis also uses -- the
  // separate fast/preview tier and its helpers were removed entirely) must
  // never read scan.competitorProfiles as an input.
  const understandingFns = [
    "async function runFullWebsiteUnderstanding",
  ];
  for (const marker of understandingFns) {
    const start = workflow.indexOf(marker);
    assert.ok(start > -1, `expected to find ${marker}`);
    const end = workflow.indexOf("\n}", start);
    const body = workflow.slice(start, end);
    assert.equal(
      body.includes("competitorProfiles"),
      false,
      `${marker} must not read competitorProfiles`,
    );
  }
});

test("competitor query terms are exactly reviewCompetitorTerms's output -- the same named-then-language-pool merge the review screen shows, capped at REVIEW_TERM_CAP", () => {
  assert.match(workflow, /function reviewCompetitorTerms/);
  assert.equal(workflow.includes("function competitorDiscoverySignals"), false,
    "the old always-append-competitor-signals helper must be gone");

  const fnStart = workflow.indexOf("function reviewCompetitorTerms");
  const fnBody = workflow.slice(fnStart, workflow.indexOf("\n}", fnStart));
  assert.match(fnBody, /business\.competitors\.value\.map\(\(competitor\) => competitor\.name\)/);
  assert.match(fnBody, /competitor\.keyphrases, \.\.\.competitor\.painPhrases/);
  assert.match(fnBody, /dedupedTerms\(\[\.\.\.named, \.\.\.languagePool\], REVIEW_TERM_CAP\)/);

  const queriesStart = workflow.indexOf("const discovery = await redditProvider.discover(");
  const queriesBlock = workflow.slice(queriesStart, queriesStart + 1500);
  assert.match(queriesBlock, /competitors: reviewCompetitors/);
  assert.match(queriesBlock, /productTerms: reviewProductTerms/);
  assert.match(queriesBlock, /customerProblems: reviewCustomerProblems/);
  // productCategory used to silently consume a product-lane query slot the
  // review screen never showed as a chip -- it must never be reintroduced.
  assert.match(queriesBlock, /productCategories: \[\]/);
});

test("reviewProductTerms/reviewCustomerProblems are capped to what the review screen actually displays, never falling through to hidden extra AI-generated entries", () => {
  assert.match(workflow, /const REVIEW_TERM_CAP = 3;/);
  assert.match(workflow, /function dedupedTerms\(/);
  assert.match(workflow, /reviewProductTerms = dedupedTerms\(business\.productTerms\.value, REVIEW_TERM_CAP\)/);
  assert.match(
    workflow,
    /reviewCustomerProblems = dedupedTerms\(\s*business\.customerProblemLanguage\.value\.length > 0[\s\S]{0,200}REVIEW_TERM_CAP,\s*\)/,
  );
});

test("redditQueryFamilies.ts itself is untouched by the competitor feature", async () => {
  const queryFamilies = await read("../lib/providers/reddit-query-families.ts");
  assert.equal(
    queryFamilies.includes("competitorProfile") || queryFamilies.includes("CompetitorProfile"),
    false,
    "the per-lane query cap/dedup logic must stay untouched -- competitor signals are just more strings in the same arrays",
  );
});

test("competitor routes require scan ownership and are rejected once the scan has started", () => {
  for (const route of [analyzeRoute, editRoute]) {
    assert.match(route, /requireOwnedScan\(actor\.workspaceId, scanId\)/);
    assert.match(route, /scan\.status === "running" \|\| scan\.status === "retrying" \|\| scan\.status === "complete"/);
  }
});

test("editing competitors only ever touches keyphrases/painPhrases, never name/url/status", () => {
  assert.match(editRoute, /function applyCompetitorEdits/);
  const start = editRoute.indexOf("function applyCompetitorEdits");
  const end = editRoute.indexOf("\n}", start);
  const body = editRoute.slice(start, end);
  // Only the object literal actually returned to the caller matters here --
  // upstream of it, matching an edit to its existing profile legitimately
  // reads/type-narrows `url`.
  const returnStart = body.indexOf("return {");
  const returnEnd = body.indexOf("};", returnStart);
  const returned = body.slice(returnStart, returnEnd);
  for (const protectedField of ["name:", "url:", "domain:", "status:", "summary:"]) {
    assert.equal(
      returned.includes(protectedField),
      false,
      `applyCompetitorEdits's returned profile must not set ${protectedField}`,
    );
  }
  assert.match(returned, /\.\.\.profile/);
  assert.match(returned, /keyphrases: "keyphrases" in edit/);
  assert.match(returned, /painPhrases: "painPhrases" in edit/);
});

test("the review screen loads competitor state for free from discovery-terms", () => {
  assert.match(termsRoute, /competitorProfiles: scan\.competitorProfiles \?\? \[\]/);
});

test("competitors are optional -- Start Scan never requires any to be analyzed", () => {
  assert.match(profileUi, /disabled=\{saving \|\| !data\?\.analyzed\}/);
  assert.equal(
    /disabled=\{saving \|\| !data\?\.analyzed \|\| competitorProfiles/.test(profileUi),
    false,
    "Scan Reddit must not be gated on competitorProfiles",
  );
});
