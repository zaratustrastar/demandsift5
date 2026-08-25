import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

/**
 * Reply generation (the "replies" stage in scan-workflow.ts) used to draft
 * one reply at a time, in a plain `for` loop, across two separate passes
 * (reply-eligible opportunities, then relevant-but-non-lead conversations)
 * -- one aiProvider.generateReply() AI call per item, sequentially, even
 * though each reply is fully independent of every other. Both loops now
 * run through the shared mapConcurrently() helper (bounded by
 * REPLY_GENERATION_CONCURRENCY), the same worker-pool pattern already
 * proven for triage batches and website crawling.
 *
 * mapConcurrently itself is dependency-free (pure Promise/Array logic), so
 * these tests extract and compile just that function from the real source
 * -- not a reimplementation -- and exercise it directly, the same way
 * ai-visibility-tracking.test.mjs isolates ai-visibility-analysis.ts.
 * Source-level checks separately confirm both call sites in
 * scan-workflow.ts actually use it, and preserve the strict
 * (throw-on-missing-content) vs. best-effort (catch-and-skip) semantics
 * each loop relied on before this change.
 */

const scanWorkflowSource = await readFile(
  new URL("../lib/server/scan-workflow.ts", import.meta.url),
  "utf8",
);

function extractMapConcurrently() {
  const start = scanWorkflowSource.indexOf("async function mapConcurrently<T, R>(");
  assert.notEqual(start, -1, "mapConcurrently was not found in scan-workflow.ts");
  // Balanced-brace scan from the function body's opening "{" so this
  // survives unrelated edits elsewhere in the file, the same technique
  // used by tests/present-access-full-override.test.mjs.
  const bodyOpen = scanWorkflowSource.indexOf("{", scanWorkflowSource.indexOf(")", start));
  let depth = 0;
  let end = bodyOpen;
  for (let i = bodyOpen; i < scanWorkflowSource.length; i += 1) {
    if (scanWorkflowSource[i] === "{") depth += 1;
    else if (scanWorkflowSource[i] === "}") {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  return scanWorkflowSource.slice(start, end);
}

async function compileMapConcurrently() {
  const source = `${extractMapConcurrently()}\nexport { mapConcurrently };\n`;
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "map-concurrently.ts",
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

const { mapConcurrently } = await compileMapConcurrently();

function windowsOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

test("items are processed with genuine overlap, not one after another", async () => {
  const windows = [];
  const delayMs = 60;
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const startedAt = Date.now();
  const results = await mapConcurrently(items, 4, async (item) => {
    const start = Date.now();
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    windows.push({ item, start, end: Date.now() });
    return item * 10;
  });
  const elapsed = Date.now() - startedAt;

  assert.deepEqual(results, [10, 20, 30, 40, 50, 60, 70, 80]);
  // 8 items at concurrency 4 is 2 "rounds" -- strictly sequential would be
  // ~8 * delayMs. Generous bound to avoid flakiness while still proving
  // real overlap.
  assert.ok(elapsed < delayMs * 4, `expected well under ${delayMs * 8}ms for 8 sequential items, got ${elapsed}ms`);
  const anyOverlap = windows.some((a, i) => windows.slice(i + 1).some((b) => windowsOverlap(a, b)));
  assert.equal(anyOverlap, true, "expected at least two items to overlap in time");
});

test("results are preserved at their original index regardless of completion order", async () => {
  // Item 0 is deliberately the slowest -- if results were appended in
  // completion order instead of written by index, this would come back
  // scrambled (e.g. [5, 5, 5, 50] instead of [50, 5, 5, 5]).
  const delays = [50, 5, 5, 5];
  const results = await mapConcurrently(delays, 4, async (delay) => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    return delay;
  });
  assert.deepEqual(results, delays);
});

test("concurrency is bounded, not unlimited", async () => {
  let concurrent = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, index) => index);
  await mapConcurrently(items, 3, async (item) => {
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 15));
    concurrent -= 1;
    return item;
  });
  assert.ok(peak > 1, "expected genuine concurrency");
  assert.ok(peak <= 3, `expected at most 3 concurrent, saw ${peak}`);
});

test("a thrown error from any item rejects the whole call -- the strict, fail-fast contract the reply-eligible-opportunities loop relies on", async () => {
  const attempted = [];
  await assert.rejects(
    mapConcurrently([1, 2, 3], 3, async (item) => {
      attempted.push(item);
      if (item === 2) throw new Error("no grounded reply");
      await new Promise((resolve) => setTimeout(resolve, 10));
      return item;
    }),
    /no grounded reply/,
  );
  // The other two items were still attempted (concurrency means they were
  // already in flight when item 2 failed), just not what determines the
  // final outcome -- the whole call still rejects.
  assert.equal(attempted.length, 3);
});

test("empty input returns an empty array without spawning any workers", async () => {
  let calls = 0;
  const results = await mapConcurrently([], 4, async () => {
    calls += 1;
    return null;
  });
  assert.deepEqual(results, []);
  assert.equal(calls, 0);
});

test("both reply-generation loops in scan-workflow.ts use mapConcurrently, not a plain sequential for loop", () => {
  assert.match(
    scanWorkflowSource,
    /const replyDrafts = await mapConcurrently\(replyEligible, REPLY_GENERATION_CONCURRENCY, async \(opportunity\) => \{/,
  );
  assert.match(
    scanWorkflowSource,
    /const relevantReplyDrafts = await mapConcurrently\(\s*relevantReplyEligible,\s*REPLY_GENERATION_CONCURRENCY,/,
  );
  assert.equal(scanWorkflowSource.includes("for (const opportunity of replyEligible)"), false);
  assert.equal(scanWorkflowSource.includes("for (const intelligence of relevantReplyEligible)"), false);
});

test("the strict loop still throws (not catches) on a missing grounded reply -- fails the whole scan, same as before", () => {
  const start = scanWorkflowSource.indexOf("const replyDrafts = await mapConcurrently(replyEligible");
  const end = scanWorkflowSource.indexOf("replies.push(...replyDrafts);", start);
  const block = scanWorkflowSource.slice(start, end);
  assert.match(block, /throw new Error\("A reply-eligible opportunity did not produce a grounded reply\."\);/);
  assert.equal(block.includes("catch"), false, "the strict loop must not swallow its own failure");
});

test("the best-effort loop still catches its own generation failure and returns null instead of throwing", () => {
  const start = scanWorkflowSource.indexOf("const relevantReplyDrafts = await mapConcurrently(");
  const end = scanWorkflowSource.indexOf("replies.push(...relevantReplyDrafts", start);
  const block = scanWorkflowSource.slice(start, end);
  assert.match(block, /catch \(error\) \{/);
  assert.match(block, /console\.error\("Relevant-conversation reply generation failed", error\);/);
  assert.match(block, /if \(!content\) return null;/);
});
