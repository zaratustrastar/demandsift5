import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

/**
 * Real production finding: discovery and triage both checkpoint progress
 * from several concurrent chunks/batches, each mutating the same in-memory
 * ScanRecord to a monotonically more complete state and then calling
 * repository.saveScan(scan) independently, with no ordering guarantee
 * between those calls. One real scan lost 5 of 8 already-completed,
 * already-paid-for Reddit query checkpoints this way: a later (more
 * complete) save's network round trip finished before an earlier (less
 * complete) save's round trip, so the earlier save landed last and
 * silently reverted the row. The next job attempt saw those 5 queries as
 * not-yet-covered and resubmitted them to Apify -- pure waste, no benefit.
 *
 * PostgresStateRepository.saveScan now queues writes per scan id so a
 * write cannot even start until the previous write for that same id has
 * fully landed, which guarantees the database always sees writes in call
 * order. This test extracts and compiles the real saveScan method (not a
 * reimplementation) and proves the ordering guarantee directly: even when
 * an earlier call's underlying write is deliberately made slower than a
 * later call's, the later call's write never starts before the earlier
 * one finishes.
 */

const source = await readFile(
  new URL("../lib/server/repository.ts", import.meta.url),
  "utf8",
);

function extractSaveScan() {
  const anchor = "// See scanSaveQueues's doc comment:";
  const start = source.indexOf(anchor);
  assert.notEqual(start, -1, "saveScan's queuing implementation was not found");
  const methodStart = source.lastIndexOf("async saveScan(record: ScanRecord, owner?: ScanExecutionOwner) {", start);
  assert.notEqual(methodStart, -1, "saveScan's signature was not found");
  // The method's closing brace is the first "\n  }\n" after the anchor --
  // matches the established one-line-of-context extraction style used
  // elsewhere in this suite (e.g. triage-candidate-budget-default.test.mjs)
  // rather than full brace-counting, since the body has no nested blocks
  // deep enough to make that ambiguous.
  const end = source.indexOf("\n  }\n", start) + "\n  }".length;
  return source.slice(methodStart, end);
}

async function compileHarness() {
  const method = extractSaveScan();
  const wrapped = `
    class Harness {
      scanSaveQueues = new Map();
      writeScan;
      constructor(writeScan) {
        this.writeScan = writeScan;
      }
      ${method}
    }
    export { Harness };
  `;
  const javascript = ts.transpileModule(wrapped, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "save-scan-harness.ts",
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

test("a slower earlier write is never overtaken by a faster later write for the same scan id", async () => {
  const { Harness } = await compileHarness();
  const started = [];
  const finished = [];
  const harness = new Harness(async (record) => {
    started.push(record.snapshot);
    // The first call is deliberately the slowest -- exactly the real
    // production scenario (an earlier, smaller checkpoint's write taking
    // longer than a later, larger checkpoint's write).
    const delayMs = record.snapshot === "A" ? 30 : 5;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    finished.push(record.snapshot);
  });

  const callA = harness.saveScan({ id: "scan_1", snapshot: "A" });
  const callB = harness.saveScan({ id: "scan_1", snapshot: "B" });
  await Promise.all([callA, callB]);

  // Both the start and finish order must match call order -- B's write must
  // not even begin until A's has completed, regardless of A being slower.
  assert.deepEqual(started, ["A", "B"]);
  assert.deepEqual(finished, ["A", "B"]);
});

test("writes for two different scan ids run independently, not serialized against each other", async () => {
  const { Harness } = await compileHarness();
  const started = [];
  const harness = new Harness(async (record) => {
    started.push(record.id);
    await new Promise((resolve) => setTimeout(resolve, record.id === "scan_1" ? 20 : 1));
  });

  await Promise.all([
    harness.saveScan({ id: "scan_1" }),
    harness.saveScan({ id: "scan_2" }),
  ]);

  // scan_2's write is not blocked behind scan_1's slower, unrelated write.
  assert.deepEqual(started.sort(), ["scan_1", "scan_2"]);
});

test("the queue entry for a scan id is cleared once its writes settle, not left growing forever", async () => {
  const { Harness } = await compileHarness();
  const harness = new Harness(async () => {});

  await harness.saveScan({ id: "scan_1" });
  assert.equal(harness.scanSaveQueues.has("scan_1"), false);
});

test("a failed write does not jam the queue -- a later write for the same scan id still runs", async () => {
  const { Harness } = await compileHarness();
  let callCount = 0;
  const harness = new Harness(async () => {
    callCount += 1;
    if (callCount === 1) throw new Error("transient DB error");
  });

  await assert.rejects(harness.saveScan({ id: "scan_1" }));
  await harness.saveScan({ id: "scan_1" });
  assert.equal(callCount, 2);
});

test("each enqueued snapshot is immutable even while the shared reducer accumulates results", async () => {
  const { Harness } = await compileHarness();
  const snapshots = [];
  const harness = new Harness(async record => { snapshots.push(record.items.slice()); });
  const record = { id: "scan_immutable", items: ["a"] };
  const first = harness.saveScan(record);
  record.items.push("b");
  const second = harness.saveScan(record);
  record.items.push("not-checkpointed");
  await Promise.all([first, second]);
  assert.deepEqual(snapshots, [["a"], ["a", "b"]]);
});
