import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(
  new URL("../lib/server/result-totals.ts", import.meta.url),
  "utf8",
);
const JavaScript = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "result-totals.ts",
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(JavaScript).toString("base64")}`;
const { summarizeTrackedResults } = await import(moduleUrl);

test("completed report totals tolerate empty tracking state", () => {
  assert.deepEqual(summarizeTrackedResults([]), {
    clicks: 0,
    conversions: 0,
    valueCents: 0,
  });
});

test("completed report totals count clicks, conversions and attributed value without reduce", () => {
  assert.deepEqual(
    summarizeTrackedResults([
      { kind: "click", valueCents: null },
      { kind: "conversion", valueCents: 1200 },
      { kind: "conversion", valueCents: 800 },
    ]),
    { clicks: 1, conversions: 2, valueCents: 2000 },
  );
  assert.doesNotMatch(source, /\.reduce\s*\(/u);
});
