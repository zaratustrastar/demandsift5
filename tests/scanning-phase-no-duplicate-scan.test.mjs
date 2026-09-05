import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

/**
 * Real production bug: after the review step creates and starts a scan
 * (reviewScanId), the "scanning" phase effect in ThreadlineExperience.tsx
 * re-fetched that scan and decided whether to reuse it by comparing the raw
 * `url` the user typed against `created.scan.websiteUrl`. By that point the
 * website-crawl stage had already overwritten `scan.websiteUrl` with the
 * canonical crawled URL (protocol added, trailing slash, etc. -- see
 * `websiteUrl: websiteCrawl.canonicalUrl` in scan-workflow.ts), so the two
 * strings essentially never matched unless the user happened to type the
 * exact canonical form. Every scan was treated as "the input changed", and
 * the app created and started a second, fully independent scan for the same
 * business -- confirmed in production via two scan rows in runtime_scans for
 * the same site 93 seconds apart, each running its own full Reddit
 * discovery.
 *
 * Fix: normalize both sides (strip protocol/trailing slash/case) before
 * comparing, so cosmetic canonicalization differences no longer look like a
 * real input change, while a genuinely different domain still does.
 */

const experienceSource = await readFile(
  new URL("../components/ThreadlineExperience.tsx", import.meta.url),
  "utf8",
);

/**
 * Extracts just the arrow function's expression body via two exact,
 * distinctive string markers (not comma-counting, which is ambiguous here
 * since the expression itself contains nested commas inside .replace(...)
 * calls) -- the signature that opens it, and the literal ",\n    [],\n  );"
 * that useCallback's empty deps array + closing paren always produces.
 */
function extractNormalizerExpression() {
  const signature = "(value: string): string =>";
  const closer = ",\n    [],\n  );";
  const start = experienceSource.indexOf(signature);
  assert.notEqual(start, -1, "normalizedWebsiteForComparison's signature was not found");
  const end = experienceSource.indexOf(closer, start);
  assert.notEqual(end, -1, "normalizedWebsiteForComparison's useCallback closing was not found");
  return experienceSource.slice(start + signature.length, end).trim();
}

async function compileNormalizer() {
  const expression = extractNormalizerExpression();
  const wrapped = `export function normalizedWebsiteForComparison(value) {\n  return ${expression};\n}`;
  const javascript = ts.transpileModule(wrapped, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "normalize.ts",
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

const { normalizedWebsiteForComparison } = await compileNormalizer();

test("strips protocol, trailing slash, and case -- the exact canonicalization difference that caused the bug", () => {
  assert.equal(
    normalizedWebsiteForComparison("https://tvcp.app/"),
    normalizedWebsiteForComparison("tvcp.app"),
  );
  assert.equal(
    normalizedWebsiteForComparison("HTTPS://TVCP.APP/"),
    normalizedWebsiteForComparison("tvcp.app"),
  );
  assert.equal(
    normalizedWebsiteForComparison("http://tvcp.app"),
    normalizedWebsiteForComparison("tvcp.app/"),
  );
});

test("a genuinely different domain is still correctly detected as a mismatch", () => {
  assert.notEqual(
    normalizedWebsiteForComparison("https://tvcp.app/"),
    normalizedWebsiteForComparison("https://example.com/"),
  );
});

test("the scanning-phase reuse check now compares normalized URLs, not raw string equality", () => {
  assert.match(
    experienceSource,
    /: normalizedWebsiteForComparison\(created\.scan\.websiteUrl\) === normalizedWebsiteForComparison\(url\)/,
  );
  // The old, broken raw comparison must be gone.
  assert.equal(experienceSource.includes("created.scan.websiteUrl === url"), false);
});

test("normalizedWebsiteForComparison is included in the scanning-phase effect's dependency array", () => {
  const start = experienceSource.indexOf("useEffect(() => {\n    if (view !== \"scanning\") return;");
  assert.notEqual(start, -1, "the scanning-phase effect was not found");
  const depsIndex = experienceSource.indexOf(
    "}, [view, url, contextText, inputMode, reviewScanId, normalizedWebsiteForComparison]);",
    start,
  );
  assert.notEqual(depsIndex, -1, "normalizedWebsiteForComparison must be a listed dependency of the effect that uses it");
});
