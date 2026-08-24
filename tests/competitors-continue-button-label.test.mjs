import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * saveAndContinue() on the "Competitors & alternatives" step has always done
 * one of two different things depending on state: if the typed URLs haven't
 * been analyzed yet, pressing the primary button analyzes them and stays on
 * the page; only a second press (once analyzedUrlsKey matches) actually
 * navigates on. The button always said "Continue" for both presses, so a
 * user who typed a competitor URL and pressed Continue saw nothing visibly
 * happen (the results appeared below, but the label gave no indication a
 * second press was needed) -- reported as "buggy, I typed continue two
 * times". This pins that the button label, and a supporting hint, now make
 * the two-step flow visible instead of silent.
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");
const source = await read("../components/CompetitorsSetup.tsx");

test("a 'needsAnalysis' flag distinguishes analyze-first from ready-to-continue, computed once and reused", () => {
  assert.match(
    source,
    /const needsAnalysis = pendingUrls\.length > 0 && pendingUrls\.join\("\|"\) !== analyzedUrlsKey;/,
  );
  // saveAndContinue's branch reuses the same flag rather than recomputing it.
  const fnStart = source.indexOf("async function saveAndContinue");
  const fnBody = source.slice(fnStart, fnStart + 300);
  assert.match(fnBody, /if \(needsAnalysis\) \{/);
});

test("the primary button says 'Analyze competitors' on the first press and 'Continue' only once analysis is caught up", () => {
  const buttonStart = source.indexOf('type="button" onClick={saveAndContinue}');
  const buttonBody = source.slice(buttonStart, buttonStart + 300);
  assert.match(buttonBody, /"Analyze competitors"/);
  assert.match(buttonBody, /"Continue"/);
  assert.match(buttonBody, /needsAnalysis/);
});

test("a hint explains that Continue will analyze first and a second press is needed to move on", () => {
  assert.match(source, /needsAnalysis && !analyzing/);
  assert.match(source, /press Continue again to move on/);
});
