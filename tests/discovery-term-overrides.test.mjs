import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

/**
 * Users can edit what DemandSift looks for. The risk this creates is
 * provenance laundering: a term the user typed has no website evidence, and if
 * it inherited the crawl's citations it would be presented as a sourced
 * finding. These tests pin that boundary, and pin that editing search terms
 * cannot rewrite what DemandSift claims to have learned about the business.
 */

const typesStub = `data:text/javascript;base64,${Buffer.from("export {};").toString("base64")}`;
const source = (
  await readFile(new URL("../lib/intelligence/discovery-overrides.ts", import.meta.url), "utf8")
).replaceAll('"@/lib/domain/types"', JSON.stringify(typesStub));

const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: "discovery-overrides.ts",
}).outputText;

const { applyDiscoveryOverrides, sanitizeDiscoveryOverrides, sanitizeDiscoveryTerms } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const cited = (value) => ({ value, confidence: "high", provenanceIds: ["src_website_1"] });

const business = () => ({
  businessId: "biz_1",
  workspaceId: "ws_1",
  websiteUrl: "https://tvcp.app",
  canonicalDomain: "tvcp.app",
  name: cited("TVCP"),
  summary: cited("Parental controls for Android TV."),
  productCategory: cited("Android TV parental control app"),
  targetAudiences: cited([{ name: "Parents", description: "Households with kids" }]),
  problemsSolved: cited(["No parental controls on Android TV"]),
  features: cited([{ name: "App blocking", verified: true }]),
  competitors: cited([
    { name: "Google Family Link", relationship: "direct", verification: "website_claim" },
  ]),
  irrelevantTopics: cited(["jailbreak"]),
  productTerms: cited(["TVCP", "Android TV parental control app"]),
  brandTerms: cited(["TVCP"]),
  customerProblemLanguage: cited(["kids watching TV too long"]),
  ambiguityRisks: cited([]),
  version: 1,
  generatedAt: "2026-08-15T00:00:00.000Z",
});

test("user-supplied terms carry no website citations", () => {
  const { business: updated } = applyDiscoveryOverrides(business(), {
    productTerms: ["Google TV screen time app"],
    updatedAt: "2026-08-15T00:00:00.000Z",
  });
  assert.deepEqual(
    updated.productTerms.provenanceIds,
    [],
    "a user's term must not inherit the crawl's provenance",
  );
  assert.equal(updated.productTerms.confidence, "low");
  assert.deepEqual(updated.productTerms.value, ["Google TV screen time app"]);
});

test("a user-named competitor is a search hint, not a verified claim", () => {
  const { business: updated } = applyDiscoveryOverrides(business(), {
    competitors: ["Some New Rival"],
    updatedAt: "2026-08-15T00:00:00.000Z",
  });
  const [competitor] = updated.competitors.value;
  assert.equal(competitor.name, "Some New Rival");
  assert.equal(competitor.verification, "unverified_hypothesis");
  assert.deepEqual(updated.competitors.provenanceIds, []);
});

test("an already-verified competitor keeps its verification when retained", () => {
  const { business: updated } = applyDiscoveryOverrides(business(), {
    competitors: ["google family link"],
    updatedAt: "2026-08-15T00:00:00.000Z",
  });
  assert.equal(updated.competitors.value[0].verification, "website_claim");
});

test("editing search terms cannot rewrite what was learned about the business", () => {
  const original = business();
  const { business: updated } = applyDiscoveryOverrides(original, {
    productTerms: ["something else"],
    customerProblems: ["a different pain"],
    updatedAt: "2026-08-15T00:00:00.000Z",
  });
  assert.deepEqual(updated.summary, original.summary);
  assert.deepEqual(updated.features, original.features);
  assert.deepEqual(updated.targetAudiences, original.targetAudiences);
  assert.deepEqual(updated.problemsSolved, original.problemsSolved);
});

test("untouched fields are left exactly as crawled", () => {
  const original = business();
  const { business: updated, overriddenFields } = applyDiscoveryOverrides(original, {
    excludedTerms: ["rooting"],
    updatedAt: "2026-08-15T00:00:00.000Z",
  });
  assert.deepEqual(overriddenFields, ["excludedTerms"]);
  assert.deepEqual(updated.productTerms, original.productTerms);
  assert.deepEqual(updated.customerProblemLanguage, original.customerProblemLanguage);
});

test("no overrides is a no-op", () => {
  const original = business();
  const { business: updated, overriddenFields } = applyDiscoveryOverrides(original, null);
  assert.equal(updated, original);
  assert.deepEqual(overriddenFields, []);
});

test("an explicitly empty list is a deliberate clear", () => {
  const { business: updated, overriddenFields } = applyDiscoveryOverrides(business(), {
    excludedTerms: [],
    updatedAt: "2026-08-15T00:00:00.000Z",
  });
  assert.deepEqual(updated.irrelevantTopics.value, []);
  assert.deepEqual(overriddenFields, ["excludedTerms"]);
});

test("terms are trimmed, de-duplicated and bounded", () => {
  const terms = sanitizeDiscoveryTerms([
    "  android tv  ",
    "Android TV",
    "",
    "   ",
    42,
    null,
    "x".repeat(500),
    ...Array.from({ length: 40 }, (_, index) => `term ${index}`),
  ]);
  assert.equal(terms[0], "android tv");
  assert.ok(!terms.includes("Android TV"), "case-insensitive duplicates are collapsed");
  assert.ok(terms.every((term) => term.length > 0 && term.length <= 120));
  assert.ok(terms.length <= 25, "an override cannot blow up query planning");
});

test("malformed override payloads are rejected rather than partially applied", () => {
  assert.equal(sanitizeDiscoveryOverrides(null), null);
  assert.equal(sanitizeDiscoveryOverrides("productTerms"), null);
  assert.equal(sanitizeDiscoveryOverrides({}), null);
  assert.equal(sanitizeDiscoveryOverrides({ unrelated: ["x"] }), null);

  const valid = sanitizeDiscoveryOverrides({ productTerms: ["a", "a", ""] });
  assert.deepEqual(valid.productTerms, ["a"]);
  assert.ok(typeof valid.updatedAt === "string");
});
