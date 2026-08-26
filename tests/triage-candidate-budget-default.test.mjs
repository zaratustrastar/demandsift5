import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

/**
 * Real production finding: discovery can retrieve up to 450 raw candidates
 * (9 query families x 50 posts each), which regularly cleans down to
 * 250-320 credible survivors. Against the old triageCandidateBudget()
 * default of 120, a real scan showed 285 credible candidates with only 2
 * dropped for genuinely low embedding similarity -- the other 163 were cut
 * purely because the budget ran out, not because they were irrelevant.
 * Raised the default to 300 so more credible candidates actually reach AI
 * triage instead of being discarded by a fixed budget alone. This pins the
 * new default and its bounds (still 20-400, unchanged) via the real,
 * compiled function -- not a reimplementation.
 */

const source = await readFile(
  new URL("../lib/server/scan-workflow.ts", import.meta.url),
  "utf8",
);

function extractTriageCandidateBudget() {
  const start = source.indexOf("function triageCandidateBudget(): number {");
  assert.notEqual(start, -1, "triageCandidateBudget was not found");
  const end = source.indexOf("\n}", start) + 2;
  return source.slice(start, end);
}

let cachedTriageCandidateBudget;

async function loadTriageCandidateBudget() {
  if (cachedTriageCandidateBudget) return cachedTriageCandidateBudget;
  const body = extractTriageCandidateBudget();
  const moduleSource = `${body}\nexport { triageCandidateBudget };\n`;
  const javascript = ts.transpileModule(moduleSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "triage-candidate-budget.ts",
  }).outputText;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
  cachedTriageCandidateBudget = mod.triageCandidateBudget;
  return cachedTriageCandidateBudget;
}

// The real triageCandidateBudget() takes no arguments and reads
// process.env.REDDIT_TRIAGE_BUDGET directly at call time, so the env swap
// must wrap the actual invocation, not just the import -- swapping it only
// around compile/import and restoring before the caller invokes the
// function would silently read back the real process env instead.
async function compileTriageCandidateBudget(env) {
  const triageCandidateBudget = await loadTriageCandidateBudget();
  return () => {
    const previousEnv = process.env.REDDIT_TRIAGE_BUDGET;
    if (env.REDDIT_TRIAGE_BUDGET === undefined) delete process.env.REDDIT_TRIAGE_BUDGET;
    else process.env.REDDIT_TRIAGE_BUDGET = env.REDDIT_TRIAGE_BUDGET;
    try {
      return triageCandidateBudget();
    } finally {
      if (previousEnv === undefined) delete process.env.REDDIT_TRIAGE_BUDGET;
      else process.env.REDDIT_TRIAGE_BUDGET = previousEnv;
    }
  };
}

test("defaults to 300 when REDDIT_TRIAGE_BUDGET is unset", async () => {
  const fn = await compileTriageCandidateBudget({});
  assert.equal(fn(), 300);
});

test("still respects an explicit REDDIT_TRIAGE_BUDGET override", async () => {
  const fn = await compileTriageCandidateBudget({ REDDIT_TRIAGE_BUDGET: "150" });
  assert.equal(fn(), 150);
});

test("the 20-400 bounds are unchanged", async () => {
  const low = await compileTriageCandidateBudget({ REDDIT_TRIAGE_BUDGET: "5" });
  assert.equal(low(), 20);
  const high = await compileTriageCandidateBudget({ REDDIT_TRIAGE_BUDGET: "10000" });
  assert.equal(high(), 400);
});

test("falls back to 300 for a non-numeric override, not the old 120", async () => {
  const fn = await compileTriageCandidateBudget({ REDDIT_TRIAGE_BUDGET: "not-a-number" });
  assert.equal(fn(), 300);
});
