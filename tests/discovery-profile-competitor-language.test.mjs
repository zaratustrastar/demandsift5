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
 * categories, without a second editing UI for the same data.
 *
 * A first pass added this as its own standalone "Competitor language" card
 * sitting right next to the editable "Competitors & alternatives" card --
 * which read as a confusing duplicate (two competitor-labeled cards, one
 * empty, right next to each other). It now lives as a read-only subsection
 * folded into the bottom of the existing "Competitors & alternatives" card
 * instead of a second card. These tests pin: (1) the discovery-terms GET
 * response's already-returned competitorProfiles field is actually consumed
 * by DiscoveryProfile.tsx, (2) the deduplicated phrases render inside the
 * "competitors" EDITABLE_FIELDS card, only when there's something to show,
 * and (3) that subsection stays read-only -- no remove/add controls --
 * since editing still happens on the earlier step.
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
  assert.match(discoveryProfileSource, /dedupedPhrases\(ready\.flatMap\(\(profile\) => profile\.keyphrases\), 3\)/);
  assert.match(discoveryProfileSource, /dedupedPhrases\(ready\.flatMap\(\(profile\) => profile\.painPhrases\), 3\)/);
  // Only "ready" competitor analyses contribute -- a failed one has no phrases to show.
  assert.match(discoveryProfileSource, /profile\.status === "ready"/);
});

test("competitor language is folded into the existing 'Competitors & alternatives' card, not a second standalone card", () => {
  assert.match(discoveryProfileSource, /key === "competitors" && competitorLanguage\.hasAny/);
  // There is exactly one place phrases render, and it's nested inside the
  // EDITABLE_FIELDS.map(...) card body, not a sibling card after it.
  const mapStart = discoveryProfileSource.indexOf("EDITABLE_FIELDS.map(");
  const mapEnd = discoveryProfileSource.indexOf("})}", discoveryProfileSource.indexOf("competitorLanguage.painPhrases.map"));
  const mapBody = discoveryProfileSource.slice(mapStart, mapEnd);
  assert.match(mapBody, /What they sell/);
  assert.match(mapBody, /Problems they speak to/);
  // No second <div className={styles.card}> for competitor language after the map.
  const afterMap = discoveryProfileSource.slice(mapEnd);
  const gridEnd = afterMap.indexOf("</section>");
  assert.equal(/styles\.card/.test(afterMap.slice(0, gridEnd)), false, "there must be no second card after the EDITABLE_FIELDS map");
});

test("competitor language shows a visible (N/3) count, matching the other cards' cap indicator", () => {
  assert.match(discoveryProfileSource, /What they sell \(\{competitorLanguage\.keyphrases\.length\}\/3\)/);
  assert.match(discoveryProfileSource, /Problems they speak to \(\{competitorLanguage\.painPhrases\.length\}\/3\)/);
});

test("the competitor language subsection is read-only -- editing still happens back on the Competitors step, not duplicated here", () => {
  const subsectionStart = discoveryProfileSource.indexOf('key === "competitors" && competitorLanguage.hasAny');
  const subsectionEnd = discoveryProfileSource.indexOf("</div>\n                )}", subsectionStart);
  const subsectionBody = discoveryProfileSource.slice(subsectionStart, subsectionEnd);
  assert.equal(/removeTerm|addTerm|<button/.test(subsectionBody), false, "the subsection must not include add/remove controls");
  assert.match(subsectionBody, /From the competitor pages you analyzed/);
});
