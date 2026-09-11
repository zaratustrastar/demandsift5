import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * A benchmark across 3 representative businesses (SaaS, e-commerce,
 * restaurant) found gpt-5.6-sol + reasoningEffort "low" 16-23% faster
 * than "medium" on 2 of 3 sites (identical on the third), with no
 * quality regression on any BusinessUnderstanding field. These tests
 * pin the production switch to "low" by default, kept configurable via
 * an env var (not hardcoded) specifically so it can be rolled back
 * without a code change, and confirm the model itself and the
 * text-description path (analyzeBusinessFromContext) are untouched.
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");

const provider = await read("../lib/providers/openai.server.ts");
const workflow = await read("../lib/server/scan-workflow.ts");

test("analysisReasoningEffortFromEnv defaults to low, and reads OPENAI_ANALYSIS_REASONING_EFFORT for rollback without a code change", () => {
  const fnStart = provider.indexOf("export function analysisReasoningEffortFromEnv");
  const fnBody = provider.slice(fnStart, provider.indexOf("\n}", fnStart));
  assert.match(fnBody, /OPENAI_ANALYSIS_REASONING_EFFORT/);
  assert.match(fnBody, /=== "medium" \? "medium" : "low"/);
});

test("analyzeBusiness's own model selection is untouched -- only reasoning effort changed", () => {
  const fnStart = provider.indexOf("async analyzeBusiness(request: AnalyzeBusinessRequest)");
  const fnBody = provider.slice(fnStart, provider.indexOf("async analyzeBusinessFromContext", fnStart));
  assert.match(fnBody, /model: request\.models\.analysisModel/);
  assert.match(fnBody, /reasoningEffort: request\.reasoningEffortOverride \?\? "medium"/);
});

test("analyzeBusinessFromContext (the describe-your-market text path) keeps its own separate hardcoded medium -- only the website-crawl path was benchmarked and changed", () => {
  const fnStart = provider.indexOf("async analyzeBusinessFromContext(");
  const fnBody = provider.slice(fnStart, fnStart + 3000);
  assert.match(fnBody, /reasoningEffort: "medium"/);
  assert.doesNotMatch(fnBody, /reasoningEffortOverride/);
});

test("both production call sites of analyzeBusiness pass the env-configured reasoning effort, not a hardcoded value", () => {
  const matches = [...workflow.matchAll(/reasoningEffortOverride: analysisReasoningEffortFromEnv\(env\)/g)];
  assert.equal(matches.length, 2);
});

test("gpt-5.6-luna is never used for analyzeBusiness -- the benchmark disqualified it for this large structured-output task (empty-output retries and a silent model fallback, 500+ seconds)", () => {
  const fnStart = workflow.indexOf("async function runFullWebsiteUnderstanding");
  const fnBody = workflow.slice(fnStart, workflow.indexOf("\n}\n", fnStart));
  assert.doesNotMatch(fnBody, /economyModel/);
  assert.match(fnBody, /aiProvider\.analyzeBusiness\(\{/);
});
