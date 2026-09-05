import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Themes are aggregated conclusions, so the wiring has to preserve the two
 * properties the product depends on: they are built from the whole relevant
 * corpus (not just qualified leads), and every theme reaches the report with
 * the sources that back it.
 */

const workflow = await readFile(
  new URL("../lib/server/scan-workflow.ts", import.meta.url),
  "utf8",
);
const presenter = await readFile(
  new URL("../lib/server/presenter.ts", import.meta.url),
  "utf8",
);
const contracts = await readFile(
  new URL("../lib/server/contracts.ts", import.meta.url),
  "utf8",
);

function position(source, fragment, label) {
  const index = source.indexOf(fragment);
  assert.notEqual(index, -1, `expected ${label} to contain ${fragment}`);
  return index;
}

test("themes are clustered from the relevant corpus, not from leads", () => {
  const themeInputs = position(workflow, "const themeInputs = relevantDeepRows", "workflow");
  const opportunities = position(workflow, "const rawOpportunities", "workflow");
  assert.ok(
    themeInputs < opportunities,
    "themes must be derived before and independently of lead selection",
  );
  assert.equal(
    workflow.includes("const themeInputs = qualifiedOpportunities"),
    false,
    "themes must not be restricted to qualified leads",
  );
});

test("both theme kinds are produced with the report's expected caps", () => {
  assert.match(workflow, /clusterThemes\(themeInputs, "struggle", \{ maxThemes: 5/);
  assert.match(workflow, /clusterThemes\(themeInputs, "request", \{ maxThemes: 4/);
});

test("themes are persisted on the scan result and exposed by the presenter", () => {
  assert.match(contracts, /conversationThemes: ConversationThemeRecord\[\]/);
  assert.match(workflow, /^\s+conversationThemes,$/m);
  assert.match(presenter, /conversationThemes: \(result\.conversationThemes \?\? \[\]\)/);
});

test("a theme without evidence never reaches the report", () => {
  // Every aggregation in the report must be able to show its supporting posts.
  assert.match(presenter, /theme\.sourceIds\.length > 0/);
});

test("stored results predating themes still present", () => {
  assert.match(
    presenter,
    /result\.conversationThemes \?\? \[\]/,
    "an older stored scan must not throw when it has no themes",
  );
});

test("the market findings cap matches the specified 3-5 range", () => {
  assert.equal(
    workflow.includes("].slice(0, 3);"),
    false,
    "the old three-insight cap discarded already-evidenced findings",
  );
  assert.match(workflow, /\]\.slice\(0, 5\);/);
});
