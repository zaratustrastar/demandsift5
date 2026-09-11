import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

/**
 * Reply generation used to draft one reply at a time, in a plain `for`
 * loop, across two separate passes (reply-eligible opportunities, then
 * relevant-but-non-lead conversations), automatically during the scan.
 * Both classes still share one priority-ordered queue through the bounded
 * mapConcurrently() helper below, but the scan itself no longer calls the
 * AI provider at all -- reply generation is on-demand only now (the
 * carousel's "Generate reply"/"Create reply" actions, see
 * reply-service.ts's regenerateReply and candidate-reply-service.ts's
 * createCandidateReply). The queue's own concurrency/ordering/failure-
 * isolation behavior is unchanged and still worth testing directly, since
 * whatever runs through it (content reuse from a checkpoint or a prior
 * scan, now that fresh generation itself doesn't happen here) still needs
 * the same bounded-concurrency, strict-vs-best-effort semantics.
 *
 * mapConcurrently itself is dependency-free (pure Promise/Array logic), so
 * these tests extract and compile just that function from the real source
 * -- not a reimplementation -- and exercise it directly, the same way
 * ai-visibility-tracking.test.mjs isolates ai-visibility-analysis.ts.
 * Source-level checks separately confirm the workflow uses the unified
 * queue and preserves strict required versus best-effort failure semantics.
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

test("a thrown error rejects after independent sibling workers have drained", async () => {
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

test("lead and relevant-conversation replies share one bounded queue", () => {
  assert.match(
    scanWorkflowSource,
    /const replyTasks = \[\.\.\.leadTasks, \.\.\.relevantTasks\];/,
  );
  assert.match(
    scanWorkflowSource,
    /mapConcurrently\(replyTasks, REPLY_GENERATION_CONCURRENCY,/,
  );
  assert.equal(scanWorkflowSource.includes("for (const opportunity of replyEligible)"), false);
  assert.equal(scanWorkflowSource.includes("mapConcurrently(relevantReplyEligible"), false);
});

test("reply generation is on-demand only now -- neither the strict-required nor the best-effort branch attempts AI generation or throws on empty content during the scan itself; only a genuine infrastructure failure (e.g. persistScan) would still hit the strict-vs-best-effort split below", () => {
  const start = scanWorkflowSource.indexOf("try { replyDrafts = await mapConcurrently(replyTasks");
  const end = scanWorkflowSource.indexOf("const insightSet = await insightPromise", start);
  const block = scanWorkflowSource.slice(start, end);
  assert.equal(block.includes("aiProvider.generateReply("), false);
  assert.equal(block.includes('throw new Error("A reply-eligible conversation did not produce a grounded reply.")'), false);
  // The strict-vs-best-effort split itself is untouched: a genuine failure
  // (not "no content yet", which is no longer an error) in saving a
  // strict/required task's reply still fails the whole scan.
  assert.match(block, /if \(task\.strict\) throw error;/);
});

test("best-effort relevant reply failure remains isolated", () => {
  const start = scanWorkflowSource.indexOf("try { replyDrafts = await mapConcurrently(replyTasks");
  const end = scanWorkflowSource.indexOf("const insightSet = await insightPromise", start);
  const block = scanWorkflowSource.slice(start, end);
  assert.match(block, /catch \(error\) \{/);
  assert.match(block, /console\.error\("Relevant-conversation reply generation failed", error\);/);
  assert.match(block, /return null;/);
});
