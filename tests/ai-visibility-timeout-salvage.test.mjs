import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

/**
 * Live evidence from the account's own Apify Console (ChatGPT Search
 * Scraper runs at 2026-08-23 19:53 and 20:13, both "Timed out" at exactly
 * 4m, both with partial Results counts of 2) showed the real failure mode
 * was never Apify permission approval -- those 403s were a red herring from
 * an earlier, wrong diagnosis. The actual cause: this Actor batches 3 live
 * AI-answered search queries per run, occasionally taking longer than the
 * previous 240s budget, and Apify killed the run right at that boundary
 * (because the code itself set Apify's own `timeout` query param to that
 * same 240s). The previous code then threw the whole run away -- including
 * the 2 of 3 answers that had already completed and been paid for -- just
 * because the terminal status was "TIMED-OUT" instead of "SUCCEEDED".
 *
 * These tests pin the fix: (1) real headroom (480s, not 240s), and (2) a
 * TIMED-OUT run with a dataset salvages whatever answers did complete
 * instead of discarding all of them, while a TIMED-OUT run with no dataset
 * at all (nothing to salvage) still correctly fails.
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
let apifySource = apifySourceRaw.replaceAll('"@/lib/providers/apify-retry"', JSON.stringify(apifyRetryModuleUrl));
const aiVisibilityApify = await import(u(cc(apifySource, "ai-visibility-apify.server.ts")));

function fakeResponse(status, bodyObject) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(bodyObject),
  };
}

test("the Actor timeout has real headroom now (>= 8 minutes), not the 4-minute value that was cutting successful runs close", () => {
  assert.match(apifySourceRaw, /const ACTOR_TIMEOUT_MS = 480_000;/);
});

test("a TIMED-OUT run with a dataset salvages the answers that finished before the cutoff, instead of discarding all of them", async () => {
  const fetchImpl = async (endpoint, init) => {
    const url = endpoint.toString();
    if (url.includes("/runs") && init?.method === "POST") {
      // Apify itself killed the run at the timeout boundary -- but it still
      // has a dataset with the 2 of 3 questions that finished in time.
      return fakeResponse(200, { data: { id: "run-timeout-1", status: "TIMED-OUT", defaultDatasetId: "ds-partial" } });
    }
    if (url.includes("/datasets/ds-partial/items")) {
      return fakeResponse(200, [
        { query: "best crm for small teams", text: "Answer one.", sources: [] },
        { query: "best alternatives to Acme", text: "Answer two.", sources: [] },
        // Third question (how to solve x) never finished -- no item for it.
      ]);
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };

  const result = await aiVisibilityApify.runVisibilityActor({
    provider: "chatgpt",
    questions: ["best crm for small teams", "best alternatives to Acme", "how to solve x"],
    token: "test-token",
    fetchImpl,
  });

  assert.equal(result.answers.length, 2, "the 2 completed answers must be salvaged, not thrown away");
  assert.deepEqual(result.failedQuestions, ["how to solve x"]);
  assert.ok(result.error, "a partial timeout must still be reported, just not as a hard failure");
  assert.match(result.error, /timed out after/);
  assert.match(result.error, /2 answers completed before the cutoff, 1 did not/);
});

test("a TIMED-OUT run with no dataset at all still fails -- there is nothing to salvage", async () => {
  const fetchImpl = async (endpoint, init) => {
    const url = endpoint.toString();
    if (url.includes("/runs") && init?.method === "POST") {
      return fakeResponse(200, { data: { id: "run-timeout-2", status: "TIMED-OUT", defaultDatasetId: "" } });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };

  await assert.rejects(
    () =>
      aiVisibilityApify.runVisibilityActor({
        provider: "gemini",
        questions: ["q1", "q2", "q3"],
        token: "test-token",
        fetchImpl,
      }),
    (error) => {
      assert.equal(error.name, "ApifyTransientError");
      return true;
    },
  );
});

test("a fully SUCCEEDED run still reports no error, exactly as before", async () => {
  const fetchImpl = async (endpoint, init) => {
    const url = endpoint.toString();
    if (url.includes("/runs") && init?.method === "POST") {
      return fakeResponse(200, { data: { id: "run-ok", status: "SUCCEEDED", defaultDatasetId: "ds-ok" } });
    }
    if (url.includes("/datasets/ds-ok/items")) {
      return fakeResponse(200, [{ query: "q1", text: "answer", sources: [] }]);
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
  const result = await aiVisibilityApify.runVisibilityActor({
    provider: "perplexity",
    questions: ["q1"],
    token: "test-token",
    fetchImpl,
  });
  assert.equal(result.error, null);
  assert.equal(result.answers.length, 1);
});
