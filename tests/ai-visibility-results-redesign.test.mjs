import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * AI Visibility results redesign: information-hierarchy/UI change only.
 * No backend, Apify, OpenAI/classification, or schedule changes -- every
 * field this reuses already existed in AiVisibilityScanSummary/
 * AiVisibilityAnswerSummary before this change (see the doc comments in
 * ProductDashboard.tsx for exactly which ones).
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");
const dashboard = await read("../components/demand-intelligence/ProductDashboard.tsx");
const dashboardCss = await read("../components/demand-intelligence/ProductDashboard.module.css");

function fnBody(source, name, endMarker) {
  const start = source.indexOf(name);
  assert.ok(start > -1, `${name} not found`);
  const end = endMarker ? source.indexOf(endMarker, start) : source.indexOf("\n}\n", start);
  return source.slice(start, end);
}

test("questions are grouped by exact question text, not by provider -- the same 3 questions are asked of every provider so this is reliable, not a heuristic", () => {
  const body = fnBody(dashboard, "function groupVisibilityAnswersByQuestion");
  assert.match(body, /scan\.questions\.map/);
  assert.match(body, /byQuestion\.get\(answer\.question\)/);
});

test("a question every provider failed to answer still gets its own row -- scan.questions, not the answers array, is the authoritative list", () => {
  const body = fnBody(dashboard, "function groupVisibilityAnswersByQuestion");
  assert.match(body, /byQuestion\.get\(question\) \?\? \[\]/);
});

test("the loading state is one generic state with no fake percentages or per-provider progress, matching the exact copy specified", () => {
  const body = fnBody(dashboard, "function AiVisibilityLoadingState");
  assert.match(body, /Checking your AI visibility now/);
  assert.match(body, /We&rsquo;re asking the same buyer questions across ChatGPT, Gemini and Perplexity\./);
  assert.match(body, /Usually takes a few minutes\./);
  assert.match(body, /Results will appear here automatically\. You can leave this page while the check continues\./);
  assert.equal(/%|progress/i.test(body), false);
});

test("the loading state only shows while a check is running/queued and no earlier successful result exists -- a background recheck never blanks out a good prior result", () => {
  const body = fnBody(dashboard, "function AiVisibilityPanel", "\n}\n");
  assert.match(body, /const isChecking = !latestSucceeded && \(latest\?\.status === "running" \|\| latest\?\.status === "queued"\);/);
});

test("once a successful result exists, the plain page header replaces the large introductory hero, keeping Tracking on and the last-check timestamp", () => {
  const body = fnBody(dashboard, "function AiVisibilityPanel", "\n}\n");
  assert.match(body, /latestSucceeded \? \(/);
  assert.match(body, /<h2>See how AI assistants represent your business<\/h2>/);
  assert.match(body, /status\.enabled \? "Tracking on" : "Tracking off"/);
  assert.match(body, /status\.lastSuccessfulScanAt/);
});

test("three summary metrics (Mentioned, Recommended, Questions checked) are computed from existing metrics/questions fields, reusing the Overview screen's own metric-card classes rather than a new card style", () => {
  const body = fnBody(dashboard, "function AiVisibilityPanel", "\n}\n");
  assert.match(body, /styles\.scMetricCard/);
  assert.match(body, /<span className=\{styles\.scMetricLabel\}>Mentioned<\/span>/);
  assert.match(body, /latestSucceeded\.metrics\?\.totalMentions/);
  assert.match(body, /<span className=\{styles\.scMetricLabel\}>Recommended<\/span>/);
  assert.match(body, /latestSucceeded\.metrics\?\.totalRecommendations/);
  assert.match(body, /<span className=\{styles\.scMetricLabel\}>Questions checked<\/span>/);
  assert.match(body, /latestSucceeded\.questions\.length/);
  // Mentioned and Recommended stay two separate metrics, never combined
  // into one blended score.
  assert.equal((body.match(/scMetricLabel\}>(Mentioned|Recommended)</g) ?? []).length, 2);
});

test("the tracked-questions section is labeled 'Questions tracked', never 'Prompts', in the customer-facing UI", () => {
  const body = fnBody(dashboard, "function AiVisibilityPanel", "\n}\n");
  assert.match(body, /<h3>Questions tracked<\/h3>/);
  assert.equal(/Prompts/i.test(body), false);
});

test("each tracked-question row shows mentioned/recommended counts and source count, and opens the drawer on click -- it never renders the full answer text inline", () => {
  const body = fnBody(dashboard, "function TrackedQuestionRow");
  assert.match(body, /Mentioned \{grouped\.mentionedCount\}\/\{total\}/);
  assert.match(body, /Recommended \{grouped\.recommendedCount\}\/\{total\}/);
  assert.match(body, /grouped\.totalSources/);
  assert.match(body, /onClick=\{onOpen\}/);
  assert.equal(body.includes("answerText"), false);
  assert.equal(body.includes("FormattedAnswerText"), false);
});

test("no existing drawer/sheet component existed in the codebase, so the detail drawer reuses the existing value-prop modal's own overlay/close-button technique rather than a new dependency", () => {
  assert.equal(/\bDrawer\b|\bSheet\b/.test(dashboardCss.split("aiVisibilityDrawer")[0] ?? ""), false);
  const body = fnBody(dashboard, "function AiVisibilityAnswerDrawer");
  assert.match(body, /styles\.valuePropClose/);
  assert.match(body, /styles\.aiVisibilityDrawerOverlay/);
});

test("the drawer groups answers by provider (ChatGPT, then Gemini, then Perplexity), each with mentioned/recommended status, the exact existing answer text via the existing FormattedAnswerText renderer, and existing sources", () => {
  const body = fnBody(dashboard, "function AiVisibilityAnswerDrawer");
  assert.match(body, /const order: AiVisibilityProvider\[\] = \["chatgpt", "gemini", "perplexity"\];/);
  assert.match(body, /<FormattedAnswerText text=\{answer\.answerText\} \/>/);
  assert.match(body, /answer\.citations\.map/);
  // No new markdown dependency and no re-summarization/regeneration --
  // the raw text is passed straight through to the existing renderer.
  assert.equal(body.includes("marked("), false);
  assert.equal(body.includes("react-markdown"), false);
});

test("the drawer header shows the buyer question and the most recent check date/time", () => {
  const body = fnBody(dashboard, "function AiVisibilityAnswerDrawer");
  assert.match(body, /<h2 className=\{styles\.aiVisibilityDrawerTitle\}>\{grouped\.question\}<\/h2>/);
  assert.match(body, /Last checked \{relativeTime\(checkedAt\)\}/);
});

test("the drawer overlay/close button reuse the exact existing value-prop modal CSS technique, not new keyboard-handling complexity the rest of the codebase doesn't have either", () => {
  assert.match(dashboardCss, /\.aiVisibilityDrawerOverlay \{[^}]*position: fixed;[^}]*\}/s);
  assert.match(dashboardCss, /\.aiVisibilityDrawerOverlay \{[^}]*z-index: 60;[^}]*\}/s);
  // No onClick handler on the overlay/drawer divs themselves -- matches
  // the existing .valuePropOverlay pattern (close only via the button),
  // avoiding the accessibility issue a div-level click handler would need
  // extra keyboard support for.
  const body = fnBody(dashboard, "function AiVisibilityAnswerDrawer");
  assert.equal(/aiVisibilityDrawerOverlay\}\s*onClick/.test(body), false);
});

test("no new markdown dependency was added, and no new spinner/loading library -- the spinner is a locally-scoped copy of the existing rotating-ring CSS technique, matching CSS Modules' own per-file keyframe scoping already used elsewhere", () => {
  assert.match(dashboardCss, /@keyframes aiVisibilitySpin/);
  assert.match(dashboardCss, /animation: aiVisibilitySpin/);
});
