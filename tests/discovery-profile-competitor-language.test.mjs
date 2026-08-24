import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Competitor keyphrases/pain phrases were only ever visible on the
 * "Competitors & alternatives" step (CompetitorsSetup.tsx) -- the very next
 * screen, "What we'll look for" (DiscoveryProfile.tsx), showed nothing about
 * them at all, even though they already silently feed the actual Reddit
 * search (see competitorDiscoverySignals in scan-workflow.ts). The user
 * wanted them visible on that next screen too, alongside the other
 * categories, without a second editing UI for the same data. These tests
 * pin: (1) the discovery-terms GET response's already-returned
 * competitorProfiles field is now actually consumed by DiscoveryProfile.tsx,
 * (2) a deduplicated, read-only "Competitor language" card renders
 * alongside the existing editable categories, and (3) it stays read-only --
 * no remove/add controls -- since editing still happens on the earlier step.
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");
const discoveryProfileSource = await read("../components/DiscoveryProfile.tsx");
const routeSource = await read("../app/api/scans/[scanId]/discovery-terms/route.ts");

test("the discovery-terms API already returns competitorProfiles (confirmed unchanged, not newly added)", () => {
  assert.match(routeSource, /competitorProfiles: scan\.competitorProfiles \?\? \[\],/);
});

test("DiscoveryProfile.tsx now reads competitorProfiles from that same response instead of ignoring it", () => {
  assert.match(discoveryProfileSource, /import type \{ CompetitorProfileView \} from "\.\/CompetitorsSetup";/);
  assert.match(discoveryProfileSource, /competitorProfiles\?: CompetitorProfileView\[\];/);
  assert.match(discoveryProfileSource, /data\?\.competitorProfiles/);
});

test("competitor language is deduplicated case-insensitively and capped, not a raw unbounded dump", () => {
  assert.match(discoveryProfileSource, /function dedupedPhrases/);
  assert.match(discoveryProfileSource, /toLocaleLowerCase\("en-US"\)/);
  assert.match(discoveryProfileSource, /dedupedPhrases\(ready\.flatMap\(\(profile\) => profile\.keyphrases\), 8\)/);
  assert.match(discoveryProfileSource, /dedupedPhrases\(ready\.flatMap\(\(profile\) => profile\.painPhrases\), 8\)/);
  // Only "ready" competitor analyses contribute -- a failed one has no phrases to show.
  assert.match(discoveryProfileSource, /profile\.status === "ready"/);
});

test("a new 'Competitor language' card renders in the same grid as the other categories, only when there is something to show", () => {
  assert.match(discoveryProfileSource, /Competitor language/);
  assert.match(discoveryProfileSource, /competitorLanguage\.hasAny &&/);
  // Lives inside the same <section className={styles.grid}> as EDITABLE_FIELDS.
  const gridStart = discoveryProfileSource.indexOf("<section className={styles.grid}>");
  const gridEnd = discoveryProfileSource.indexOf("</section>", gridStart);
  const gridBody = discoveryProfileSource.slice(gridStart, gridEnd);
  assert.match(gridBody, /Competitor language/);
});

test("the competitor language card is read-only -- editing still happens back on the Competitors step, not duplicated here", () => {
  const cardStart = discoveryProfileSource.indexOf("competitorLanguage.hasAny &&");
  const cardEnd = discoveryProfileSource.indexOf("</section>", cardStart);
  const cardBody = discoveryProfileSource.slice(cardStart, cardEnd);
  assert.equal(/removeTerm|addTerm|<button/.test(cardBody), false, "the new card must not include add/remove controls");
  assert.match(cardBody, /Edit these back on the Competitors/);
});
