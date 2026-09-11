import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Redesign of ResultsPreview, the anonymous-only "Scan complete" screen
 * (confirmed by tracing the view state machine: every transition to
 * "results" is guarded by userAccount ? "report" : "results" -- an
 * already-authenticated user always skips straight to the full
 * dashboard). Goal: value-first information hierarchy, using only data
 * already computed elsewhere -- no new AI calls, no new scan/ranking
 * logic, no persistence/auth changes. The underlying "Keep these
 * results" action (onKeep, still () => setView("signup")) is unchanged;
 * only its copy and the surrounding screen changed.
 */

const experience = await readFile(new URL("../components/ThreadlineExperience.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../components/ThreadlineExperience.module.css", import.meta.url), "utf8");

function fnBody(source, name, endMarker) {
  const start = source.indexOf(name);
  assert.ok(start > -1, `${name} not found`);
  const end = endMarker ? source.indexOf(endMarker, start + name.length) : source.indexOf("\n}\n", start);
  return source.slice(start, end);
}

test("onKeep's underlying behavior is unchanged -- still navigates to the signup step, never saves/claims directly itself", () => {
  assert.match(experience, /onKeep=\{\(\) => setView\("signup"\)\}/);
});

test("the headline uses the actual analyzed business name dynamically, replacing the generic 'Here's what we found'", () => {
  const body = fnBody(experience, "function ResultsPreview", "\nfunction ");
  assert.match(body, /<h1>We found real demand for \{data\.business\.name\}<\/h1>/);
  assert.equal(/Here.s what we found/.test(body), false);
});

test("the supporting copy is the short, specified line -- not the old conditional multi-clause sentence", () => {
  const body = fnBody(experience, "function ResultsPreview", "\nfunction ");
  assert.match(body, /Scooptr analyzed Reddit conversations and ranked the strongest opportunities for you\./);
});

test("metric cards are built only from already-existing, already-computed values -- no new metric computation, and empty ones are omitted rather than shown as zero", () => {
  const body = fnBody(experience, "function ResultsPreview", "\nfunction ");
  assert.match(body, /value: summary\.promisingConversations, label: "Relevant conversations"/);
  assert.match(body, /value: highIntentOpportunities, label: "High-intent opportunities"/);
  assert.match(body, /value: summary\.readyReplies, label: "Replies ready"/);
  assert.match(body, /value: summary\.marketInsights, label: "Market insights"/);
  assert.match(body, /\.filter\(\(card\) => card\.value > 0\)/);
});

test("the full generated reply draft is no longer rendered on this screen", () => {
  const body = fnBody(experience, "function ResultsPreview", "\nfunction ");
  assert.equal(/reply\.draft|reply\?\.draft/.test(body), false);
  assert.equal(/resultsPrimaryReply/.test(body), false);
});

test("the dead .resultsPrimaryReply CSS rule was removed along with its last usage", () => {
  assert.equal(/\.resultsPrimaryReply\s*\{/.test(css), false);
});

test("the strongest opportunity shows a relevance badge, subreddit, title, and why-it-matters -- matching the existing relevance-badge visual language (var(--green-dark)/var(--mint)) rather than inventing a new one", () => {
  const body = fnBody(experience, "function ResultsPreview", "\nfunction ");
  assert.match(body, /styles\.resultsRelevanceBadge/);
  assert.match(body, /Math\.round\(strongest\.reliability\)/);
  assert.match(body, /strongest\.reliability >= 85 \? "High relevance" : "Relevance"/);
  const cssBody = css.slice(css.indexOf(".resultsRelevanceBadge"), css.indexOf(".resultsPrimaryAction"));
  assert.match(cssBody, /var\(--mint\)/);
  assert.match(cssBody, /var\(--green-dark\)/);
});

test("'Review opportunity' triggers the same underlying onKeep action -- not a second, different navigation path, keeping one real primary action", () => {
  const body = fnBody(experience, "function ResultsPreview", "\nfunction ");
  assert.match(body, /className=\{styles\.resultsPrimaryAction\} onClick=\{onKeep\}>\s*Review opportunity/);
});

test("the secondary list is capped at 3 additional items, down from the previous 10, and each row now shows its relevance score", () => {
  const body = fnBody(experience, "function ResultsPreview", "\nfunction ");
  assert.match(body, /const additional = items\.slice\(1, 4\);/);
  assert.match(body, /styles\.resultsRowScore/);
});

test("the ongoing-value section only names functionality that genuinely exists today (Reddit monitoring, competitor tracking, AI Visibility)", () => {
  const body = fnBody(experience, "function ResultsPreview", "\nfunction ");
  assert.match(body, /This doesn&apos;t have to be a one-time scan/);
  assert.match(body, /keep watching Reddit for new conversations, track competitors and check how/);
  assert.match(body, /ChatGPT, Gemini and Perplexity talk about your business/);
});

test("the primary CTA copy describes the real action (proceeding to save) rather than 'Keep these results' or an inaccurate instant save-and-open claim", () => {
  const body = fnBody(experience, "function ResultsPreview", "\nfunction ");
  assert.match(body, />\s*Save my results →\s*<\/button>/);
  assert.equal(/Keep these results/.test(body), false);
});

test("there is exactly one styled primary CTA button (.tryAgain) on this screen -- 'Review opportunity' is a lightweight text action, not a second competing button style", () => {
  const body = fnBody(experience, "function ResultsPreview", "\nfunction ");
  const primaryButtonMatches = body.match(/className=\{styles\.tryAgain\}/g) ?? [];
  assert.equal(primaryButtonMatches.length, 1);
});

test("the 30-day expiration detail no longer leads the screen -- it's a short note next to the save CTA, not the first thing communicated", () => {
  const body = fnBody(experience, "function ResultsPreview", "\nfunction ");
  assert.match(body, /Save your scan to keep these results and continue monitoring\./);
  assert.match(body, /Unsaved results expire after 30 days\./);
  const noteIndex = body.indexOf("Save your scan to keep these results");
  const h1Index = body.indexOf("<h1>");
  const ctaIndex = body.indexOf("Save my results");
  assert.ok(h1Index < noteIndex && noteIndex < ctaIndex);
});

test("no new AI calls or network requests were introduced -- ResultsPreview only reads data already passed into it", () => {
  const body = fnBody(experience, "function ResultsPreview", "\nfunction ");
  assert.equal(/fetch\(|await /.test(body), false);
});
