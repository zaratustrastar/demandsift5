import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

/**
 * A live scan (deployed after the timeout fix) showed the gap that fix
 * didn't cover: ChatGPT Search Scraper's run reported status SUCCEEDED but
 * returned zero answers for all 3 questions -- not a timeout, and Apify
 * itself considers this a clean, completed run (it wraps a Google Search
 * Scraper, and for a niche enough query the underlying search can come back
 * empty). The old code only attached a soft `error` note for the
 * TIMED-OUT-with-partial-results case, so a SUCCEEDED-but-empty run was
 * completely silent -- exactly the "No answer was returned for this
 * question" with no explanation the user saw. This is now generalized: any
 * run (SUCCEEDED or TIMED-OUT) that comes back with fewer answers than
 * questions carries an explanatory note, worded differently depending on
 * whether it's a timeout or just an empty result.
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");
const u = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const cc = (source, fileName) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName,
  }).outputText;

const apifyRetrySource = await read("../lib/providers/apify-retry.ts");
const apifyRetryModuleUrl = u(cc(apifyRetrySource, "apify-retry.ts"));

const apifySourceRaw = await read("../lib/providers/ai-visibility-apify.server.ts");
const apifySource = apifySourceRaw.replaceAll('"@/lib/providers/apify-retry"', JSON.stringify(apifyRetryModuleUrl));
const aiVisibilityApify = await import(u(cc(apifySource, "ai-visibility-apify.server.ts")));

function fakeResponse(status, bodyObject) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(bodyObject),
  };
}

test("a SUCCEEDED run with zero answers explains itself instead of failing silently", async () => {
  const fetchImpl = async (endpoint, init) => {
    const url = endpoint.toString();
    if (url.includes("/runs") && init?.method === "POST") {
      return fakeResponse(200, { data: { id: "run-empty", status: "SUCCEEDED", defaultDatasetId: "ds-empty" } });
    }
    if (url.includes("/datasets/ds-empty/items")) {
      return fakeResponse(200, []);
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };

  const result = await aiVisibilityApify.runVisibilityActor({
    provider: "chatgpt",
    questions: ["q1", "q2", "q3"],
    token: "test-token",
    fetchImpl,
  });

  assert.equal(result.answers.length, 0);
  assert.deepEqual(result.failedQuestions, ["q1", "q2", "q3"]);
  assert.ok(result.error, "a silent zero-answer SUCCEEDED run must now carry an explanatory note");
  assert.match(result.error, /completed but did not return an answer for any/);
  // Must not be misdescribed as a timeout when it wasn't one.
  assert.doesNotMatch(result.error, /timed out/);
});

test("a SUCCEEDED run with some (not all) answers also explains the gap", async () => {
  const fetchImpl = async (endpoint, init) => {
    const url = endpoint.toString();
    if (url.includes("/runs") && init?.method === "POST") {
      return fakeResponse(200, { data: { id: "run-partial", status: "SUCCEEDED", defaultDatasetId: "ds-partial" } });
    }
    if (url.includes("/datasets/ds-partial/items")) {
      return fakeResponse(200, [{ query: "q1", text: "answer", sources: [] }]);
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };

  const result = await aiVisibilityApify.runVisibilityActor({
    provider: "gemini",
    questions: ["q1", "q2"],
    token: "test-token",
    fetchImpl,
  });

  assert.equal(result.answers.length, 1);
  assert.deepEqual(result.failedQuestions, ["q2"]);
  assert.ok(result.error);
  assert.match(result.error, /completed with 1 of 2 questions answered/);
});
