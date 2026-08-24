import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Competitor keyphrases/pain phrases were only ever visible on the
 * "Competitors & alternatives" onboarding step (CompetitorsSetup.tsx) --
 * the very next screen, "What we'll look for" (DiscoveryProfile.tsx),
 * showed nothing about them at all, even though they already silently feed
 * the actual Reddit search (see competitorDiscoverySignals in
 * scan-workflow.ts). The user wanted them visible on that next screen too,
 * alongside the other categories.
 *
 * Two earlier passes at this were both corrected by the user:
 *  1. a standalone "Competitor language" card sitting next to the editable
 *     "Competitors & alternatives" card read as a confusing duplicate;
 *  2. folding it into that same card as a second, read-only subsection
 *     (with its own "(N/3)" counts) still didn't match how the other two
 *     cards (Product / category, Customer problems) work -- one flat,
 *     fully editable, single-count chip list.
 *
 * The competitor language is now merged directly into the same
 * "competitors" chip list Product/category and Customer problems already
 * use: named competitors first, then keyphrases/pain phrases from analyzed
 * competitor pages filling any remaining slots (deduplicated, capped at 3
 * total), all equally editable/removable. These tests pin: (1) the
 * discovery-terms GET response's competitorProfiles field is consumed to
 * build that seed, (2) the merge is named-first with a case-insensitive
 * dedup, and (3) there is no separate read-only section or extra count
 * anywhere in the card -- it renders through the exact same EDITABLE_FIELDS
 * path as the other two categories.
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");
const discoveryProfileSource = await read("../components/DiscoveryProfile.tsx");
const routeSource = await read("../app/api/scans/[scanId]/discovery-terms/route.ts");

test("the discovery-terms API already returns competitorProfiles (confirmed unchanged, not newly added)", () => {
  assert.match(routeSource, /competitorProfiles: scan\.competitorProfiles \?\? \[\],/);
});

test("DiscoveryProfile.tsx reads competitorProfiles from that same response and folds it into the competitors seed", () => {
  assert.match(discoveryProfileSource, /import type \{ CompetitorProfileView \} from "\.\/CompetitorsSetup";/);
  assert.match(discoveryProfileSource, /competitorProfiles\?: CompetitorProfileView\[\];/);
  assert.match(discoveryProfileSource, /payload\.competitorProfiles/);
});

test("competitor language is deduplicated case-insensitively, and only 'ready' analyses contribute", () => {
  assert.match(discoveryProfileSource, /function dedupedPhrases/);
  assert.match(discoveryProfileSource, /toLocaleLowerCase\("en-US"\)/);
  assert.match(discoveryProfileSource, /profile\.status === "ready"/);
  assert.match(discoveryProfileSource, /\[\.\.\.profile\.keyphrases, \.\.\.profile\.painPhrases\]/);
});

test("named competitors are merged with competitor-language phrases into one seed, named first, capped at MAX_TERMS.competitors -- only when there's no saved override yet", () => {
  assert.match(
    discoveryProfileSource,
    /dedupedPhrases\(\[\.\.\.\(base\?\.competitors \?\? \[\]\), \.\.\.competitorLanguagePool\], MAX_TERMS\.competitors\)/,
  );
  // A saved override is shown as-is, never re-merged with the language pool
  // on every reload (that would silently re-add phrases the user removed).
  assert.match(discoveryProfileSource, /overrides\?\.competitors\s*\n\s*\? overrides\.competitors\.slice\(0, MAX_TERMS\.competitors\)/);
});

test("there is no second, read-only competitor-language section anywhere in the card -- it renders through the same EDITABLE_FIELDS.map as the other two categories", () => {
  assert.equal(discoveryProfileSource.includes("Competitor language"), false);
  assert.equal(discoveryProfileSource.includes("What they sell"), false);
  assert.equal(discoveryProfileSource.includes("Problems they speak to"), false);
  assert.equal(/key === "competitors"/.test(discoveryProfileSource), false);
  // Only one useMemo (`edited`) remains -- the old `competitorLanguage`
  // useMemo that built the second section is gone.
  const useMemoCount = (discoveryProfileSource.match(/useMemo\(/g) ?? []).length;
  assert.equal(useMemoCount, 1);
});

test("the competitors card has exactly one (N/3) count, sourced from the same {hint} ({terms[key].length}/{max}) line every card uses", () => {
  const mapStart = discoveryProfileSource.indexOf("EDITABLE_FIELDS.map(");
  const mapEnd = discoveryProfileSource.indexOf("})}", mapStart);
  const mapBody = discoveryProfileSource.slice(mapStart, mapEnd);
  const countOccurrences = (mapBody.match(/\{terms\[key\]\.length\}\/\{max\}/g) ?? []).length;
  assert.equal(countOccurrences, 1, "the (N/3) count line must appear exactly once, shared by all three cards via the same map");
});
