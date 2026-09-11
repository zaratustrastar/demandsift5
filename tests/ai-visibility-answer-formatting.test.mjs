import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * AI visibility answer text comes back from each provider as raw
 * markdown-ish text (bold via **, GitHub-style tables, numbered citation
 * markers like [8][15]), previously dumped into a single <p> with
 * white-space: pre-wrap -- which is exactly what made a real Perplexity
 * answer render as an unbroken wall of asterisks, pipes and brackets. These
 * are source-level checks (this file has no DOM/JSX runtime available) that
 * a small, dependency-free formatter now parses tables and bold/citation
 * markers instead of dumping the raw string.
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");
const dashboardSource = await read("../components/demand-intelligence/ProductDashboard.tsx");

test("a dedicated formatter replaces the raw markdown dump, and no markdown library was added", () => {
  assert.match(dashboardSource, /function FormattedAnswerText/);
  assert.match(dashboardSource, /<FormattedAnswerText text={answer\.answerText} \/>/);
  // The old raw dump is gone from the answer-rendering call site.
  assert.equal(dashboardSource.includes("<p>{answer.answerText}</p>"), false);
});

test("the formatter parses GitHub-style markdown tables into real <table> markup", () => {
  assert.match(dashboardSource, /function parseAnswerBlocks/);
  assert.match(dashboardSource, /type: "table"/);
  assert.match(dashboardSource, /<table key={blockIndex} className={styles\.answerTable}>/);
  assert.match(dashboardSource, /isTableSeparatorRow/);
});

test("bold text and numbered citation markers are rendered as real markup, not left as literal ** and [12]", () => {
  assert.match(dashboardSource, /function renderInlineAnswerMarkdown/);
  assert.match(dashboardSource, /<strong key={`\$\{keyPrefix\}-b-\$\{matchIndex\}`}>\{match\[1\]\}<\/strong>/);
  assert.match(dashboardSource, /<sup key={`\$\{keyPrefix\}-c-\$\{matchIndex\}`} className={styles\.answerCitationMark}>/);
});

const packageJson = await read("../package.json");
test("no new markdown-rendering dependency was introduced for this", () => {
  assert.equal(/"(react-markdown|marked|remark|markdown-it)"/i.test(packageJson), false);
});
