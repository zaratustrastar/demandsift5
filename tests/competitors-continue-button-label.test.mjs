import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * saveAndContinue() on the "Competitors & alternatives" step used to do one
 * of two different things depending on state: if the typed URLs hadn't been
 * analyzed yet, pressing the primary button analyzed them, showed the
 * result (name + one-line summary) for review, and stayed on the page --
 * only a second, identically-labeled press actually navigated on. A user
 * who typed a competitor URL and pressed Continue saw the summary appear
 * and nothing else visibly happen, reported as "buggy, I typed continue two
 * times" and, once the summary card was visible, "it's good for ai context
 * but user does NOT need to see this, we should proceed to next page once
 * it's ready."
 *
 * Both are fixed the same way: a competitor's analyzed profile is context
 * DemandSift uses for its own query building, not something the user
 * reviews, so a single Continue press now analyzes (if there's anything new
 * to analyze) and moves on by itself. The only time it stays on the page is
 * if a URL actually failed to analyze, so the user can see what needs
 * fixing instead of silently losing that competitor.
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");
const source = await read("../components/CompetitorsSetup.tsx");

test("a 'needsAnalysis' flag decides whether there's anything new to analyze before continuing", () => {
  assert.match(
    source,
    /const needsAnalysis = pendingUrls\.length > 0 && pendingUrls\.join\("\|"\) !== analyzedUrlsKey;/,
  );
});

test("saveAndContinue analyzes first when needed, then navigates on by itself -- no second press required on success", () => {
  const fnStart = source.indexOf("async function saveAndContinue");
  const fnBody = source.slice(fnStart, source.indexOf("\n  }\n", fnStart));
  assert.match(fnBody, /if \(needsAnalysis\) \{/);
  assert.match(fnBody, /const profiles = await analyzeCompetitors\(pendingUrls\);/);
  // Only a hard failure or a per-URL failed status stops it from continuing.
  assert.match(fnBody, /if \(!profiles \|\| profiles\.some\(\(profile\) => profile\.status === "failed"\)\) return;/);
  // The success path falls through to onContinue() unconditionally -- no
  // separate "second press" branch or state gates it.
  assert.match(fnBody.trimEnd(), /onContinue\(\);$/);
});

test("the primary button always reads 'Continue to search setup' (or 'Analyzing competitors…' while in flight) -- there is no separate 'Analyze competitors' label to teach the user", () => {
  const buttonStart = source.indexOf('type="button" onClick={saveAndContinue}');
  const buttonBody = source.slice(buttonStart, buttonStart + 300);
  assert.match(buttonBody, /"Continue to search setup/);
  assert.equal(buttonBody.includes("Analyze competitors"), false);
});

test("a successful analysis never renders the profile summary -- it's AI context, not a user-facing review step", () => {
  assert.equal(source.includes("needsAnalysis && !analyzing"), false);
  assert.match(source, /competitorProfiles\.some\(\(profile\) => profile\.status === "failed"\)/);
});

/**
 * The 20-25 second wait on this step had almost no feedback: the button
 * label change to "Analyzing competitors..." was the only signal. Adds a
 * spinner inside that same button plus two short helper lines below the
 * actions row, shown only while analyzing is true -- no new loading
 * screen, no fake progress, no change to the analysis itself.
 */
test("the spinner and both helper lines render only while analyzing, and disappear automatically once it's done (no separate visibility state to fall out of sync)", () => {
  assert.match(source, /\{analyzing && <span className=\{styles\.spinner\} aria-hidden="true" \/>\}/);
  assert.match(source, /\{analyzing && \(\s*<>\s*<p className=\{styles\.note\}>/);
  assert.match(source, /Comparing your business with competitors to find the right search phrases\./);
  assert.match(source, /Usually takes about 20–30 seconds\./);
  assert.match(source, /className=\{styles\.noteSecondary\}/);
});

test("the spinner reuses the same rotate-360 keyframe technique as the existing full-screen loader, just resized/recolored for inline button use -- not a new animation style", async () => {
  const css = await readFile(new URL("../components/DiscoveryProfile.module.css", import.meta.url), "utf8");
  assert.match(css, /@keyframes spin \{ to \{ transform: rotate\(360deg\); \} \}/);
  assert.match(css, /\.spinner \{[\s\S]{0,200}animation: spin/);
});

test("the second helper line is styled as a lighter sub-line of the first (same width/color/font-size as .note, reduced opacity, smaller top margin) rather than a new arbitrary style", async () => {
  const css = await readFile(new URL("../components/DiscoveryProfile.module.css", import.meta.url), "utf8");
  const block = css.slice(css.indexOf(".noteSecondary {"), css.indexOf(".noteSecondary {") + 250);
  assert.match(block, /color: var\(--muted\);/);
  assert.match(block, /font-size: 12px;/);
  assert.match(block, /opacity: \.75;/);
});
