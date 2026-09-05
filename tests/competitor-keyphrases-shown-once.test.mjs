import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Competitor keyphrases/pain phrases were shown, and editable, twice: once
 * on the "Competitors & alternatives" step right after analysis
 * (CompetitorsSetup.tsx), and then again (see
 * discovery-profile-competitor-language.test.mjs) as a new read-only card on
 * the very next screen. The user asked for them to appear exactly once, on
 * the next screen only. This pins the removal side: the Competitors step no
 * longer renders or edits phrase chips at all -- just the competitor's name
 * and one-line summary -- while still fully analyzing and persisting the
 * competitor profiles (POST /api/competitors/analyze already saves
 * competitorProfiles onto the scan on its own, independent of the removed
 * edit flow, so the next screen's card still has real data to show).
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");
const competitorsSetupSource = await read("../components/CompetitorsSetup.tsx");
const analyzeRouteSource = await read("../app/api/competitors/analyze/route.ts");

// Strips comments so a doc-comment explaining *why* the phrase UI was
// removed (which necessarily names "keyphrases"/"pain phrases" in prose)
// doesn't false-positive as the removed UI still being present -- same
// precedent as ai-visibility-tracking.test.mjs's stripComments.
const codeOnly = competitorsSetupSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the Competitors & alternatives step no longer shows or edits keyphrase/pain-phrase chips", () => {
  assert.equal(/Keyphrases/.test(codeOnly), false);
  assert.equal(/Pain phrases/.test(codeOnly), false);
  assert.equal(competitorsSetupSource.includes("removeCompetitorPhrase"), false);
  assert.equal(competitorsSetupSource.includes("addCompetitorPhrase"), false);
  assert.equal(competitorsSetupSource.includes("COMPETITOR_PHRASE_FIELDS"), false);
  assert.equal(competitorsSetupSource.includes("MAX_COMPETITOR_PHRASES"), false);
  // The PUT /api/competitors save-on-edit call (only ever triggered by the
  // now-removed phrase editing) is gone from the continue flow too.
  const continueStart = competitorsSetupSource.indexOf("async function saveAndContinue");
  const continueEnd = competitorsSetupSource.indexOf("\n  }", continueStart);
  assert.equal(competitorsSetupSource.slice(continueStart, continueEnd).includes('"/api/competitors"'), false);
});

test("a competitor's name/summary are never shown to the user -- only a failed analysis surfaces, as something to fix", () => {
  // A fully successful analysis is context for DemandSift's own query
  // building, not something the user reviews (see competitors-continue-  // button-label.test.mjs for the auto-continue behavior this backs). Only
  // a failed URL renders anything at all, and even then, just the domain
  // and error -- never profile.summary.
  assert.equal(codeOnly.includes("profile.summary"), false);
  assert.match(competitorsSetupSource, /profile\.name \|\| profile\.domain/);
  assert.match(competitorsSetupSource, /Could not analyze \{profile\.domain\}/);
  assert.match(competitorsSetupSource, /profile\.status === "failed"/);
});

test("analysis still persists competitorProfiles on its own, so the next screen's card keeps working without the removed edit flow", () => {
  assert.match(analyzeRouteSource, /competitorProfiles,\s*\n\s*updatedAt: new Date\(\)\.toISOString\(\),/);
});
