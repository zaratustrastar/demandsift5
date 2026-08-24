import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

/**
 * The 3 official AI visibility Apify Actors are full-permission Actors, and
 * Apify now requires a one-time human approval in Apify Console before any
 * full-permission Actor can be called via the API -- an unapproved call
 * fails with HTTP 403 and a structured `{error: {type, message, data:
 * {approvalUrl}}}` body (see
 * https://apify.com/change-log/full-permission-actors-approval). Before this
 * change, ai-visibility-apify.server.ts discarded that body entirely and
 * threw a bare "HTTP 403" -- meaning a user whose scan silently came back
 * empty for a provider had no way to find out why, and neither did anyone
 * debugging it after the fact. These tests pin: (1) the real, compiled
 * runVisibilityActor/runAllVisibilityActors now surface Apify's own
 * diagnosis and remediation link instead of a bare status code, and (2) that
 * per-provider reason is threaded all the way through the workflow and
 * repository into a persisted, queryable field for the results view.
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");
const u = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const cc = (source, fileName) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName,
  }).outputText;

// apify-retry.ts is real, dependency-free source (see harshmaur-provider.test.mjs
// for the same precedent): compiled and executed for real, not re-described,
// since retry/non-retry classification of the 403 is exactly what's under test.
const apifyRetrySource = await read("../lib/providers/apify-retry.ts");
const apifyRetryModuleUrl = u(cc(apifyRetrySource, "apify-retry.ts"));

let apifySource = await read("../lib/providers/ai-visibility-apify.server.ts");
apifySource = apifySource.replaceAll('"@/lib/providers/apify-retry"', JSON.stringify(apifyRetryModuleUrl));
const aiVisibilityApify = await import(u(cc(apifySource, "ai-visibility-apify.server.ts")));

const workflowSource = await read("../lib/server/ai-visibility-workflow.ts");
const repositorySource = await read("../lib/server/ai-visibility-repository.ts");
const contractsSource = await read("../lib/server/contracts.ts");
const schemaSource = await read("../db/postgres/schema.ts");
const migrationSource = await read("../db/migrations/0009_ai_visibility_provider_errors.sql");
const routeSource = await read("../app/api/ai-visibility/settings/route.ts");

function fakeResponse(status, bodyObject) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(bodyObject),
  };
}

const APPROVAL_URL = "https://console.apify.com/actors/bgGC9uvqqfOkeeVjY?approvePermissions=true";
const APPROVAL_ERROR_BODY = {
  error: {
    type: "full-permission-actor-not-approved",
    message: "This Actor requires full access to your account. You must approve its permissions before running it.",
    data: { approvalUrl: APPROVAL_URL },
  },
};

test("a real 403 full-permission-actor-not-approved response surfaces Apify's own approval link, not a bare HTTP 403", async () => {
  const fetchImpl = async () => fakeResponse(403, APPROVAL_ERROR_BODY);
  await assert.rejects(
    () =>
      aiVisibilityApify.runVisibilityActor({
        provider: "chatgpt",
        questions: ["q1", "q2", "q3"],
        token: "test-token",
        fetchImpl,
      }),
    (error) => {
      assert.match(error.message, /never been approved/);
      assert.match(error.message, /full-permission Actor/);
      assert.ok(error.message.includes(APPROVAL_URL), "expected the message to include Apify's real approval URL");
      // Non-retryable: approval can only be granted by a human in Apify
      // Console (per Apify's own docs), so retrying must never be attempted.
      assert.notEqual(error.name, "ApifyTransientError");
      return true;
    },
  );
});

test("a 403 with no structured Apify error body still falls back to a plain, honest message", async () => {
  const fetchImpl = async () => fakeResponse(403, {});
  await assert.rejects(
    () =>
      aiVisibilityApify.runVisibilityActor({
        provider: "gemini",
        questions: ["q1"],
        token: "test-token",
        fetchImpl,
      }),
    /gemini visibility Actor request failed with HTTP 403/,
  );
});

test("a retryable Apify status (e.g. 429) is still classified as transient after the error-parsing change", async () => {
  const fetchImpl = async () => fakeResponse(429, { error: { message: "Rate limited" } });
  await assert.rejects(
    () =>
      aiVisibilityApify.runVisibilityActor({
        provider: "perplexity",
        questions: ["q1"],
        token: "test-token",
        fetchImpl,
      }),
    (error) => {
      assert.equal(error.name, "ApifyTransientError");
      assert.match(error.message, /Rate limited/);
      return true;
    },
  );
});

test("runAllVisibilityActors: one provider's approval failure never sinks the other two, and only the failing provider gets an error", async () => {
  const fetchImpl = async (endpoint, init) => {
    const url = endpoint.toString();
    if (url.includes("chatgpt-search-scraper")) {
      return fakeResponse(403, APPROVAL_ERROR_BODY);
    }
    if (url.includes("/runs") && init?.method === "POST") {
      return fakeResponse(200, { data: { id: `run-${url.includes("gemini") ? "g" : "p"}`, status: "SUCCEEDED", defaultDatasetId: "ds1" } });
    }
    if (url.includes("/datasets/")) {
      // A real, fully successful run: all 3 questions answered, so gemini
      // and perplexity must come back with no error at all.
      return fakeResponse(200, [
        { query: "q1", text: "answer 1", sources: [] },
        { query: "q2", text: "answer 2", sources: [] },
        { query: "q3", text: "answer 3", sources: [] },
      ]);
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };

  const results = await aiVisibilityApify.runAllVisibilityActors({
    questions: ["q1", "q2", "q3"],
    token: "test-token",
    fetchImpl,
  });

  const chatgpt = results.find((result) => result.provider === "chatgpt");
  const gemini = results.find((result) => result.provider === "gemini");
  const perplexity = results.find((result) => result.provider === "perplexity");

  assert.ok(chatgpt.error, "chatgpt's Actor failure must be recorded");
  assert.match(chatgpt.error, /never been approved/);
  assert.deepEqual(chatgpt.answers, []);

  assert.equal(gemini.error, null, "gemini succeeded and must have no error");
  assert.equal(perplexity.error, null, "perplexity succeeded and must have no error");
});

test("the workflow records a per-provider error for any Actor whose run failed, and null for the ones that didn't", () => {
  assert.match(workflowSource, /providerErrors: Record<AiVisibilityAiProvider, string \| null> = \{/);
  assert.match(workflowSource, /if \(result\.error\) providerErrors\[result\.provider\] = result\.error;/);
  // Attached to the record that actually gets persisted via completeAiVisibilityScan.
  const metricsIndex = workflowSource.indexOf("const metrics = computeVisibilityMetrics(draftAnswers);");
  const nearby = workflowSource.slice(metricsIndex, metricsIndex + 300);
  assert.match(nearby, /providerErrors,/);
});

test("a missing APIFY_TOKEN is reported as a provider error too, not a silent all-blank scan", () => {
  assert.match(workflowSource, /missingTokenMessage/);
  assert.match(workflowSource, /error: missingTokenMessage/);
});

test("providerErrors is a first-class field on AiVisibilityScanRecord and is persisted through create, save, and complete", () => {
  assert.match(contractsSource, /providerErrors: Record<AiVisibilityAiProvider, string \| null>;/);
  assert.match(repositorySource, /function defaultProviderErrors\(\)/);
  assert.match(repositorySource, /providerErrors: record\.providerErrors,/);
  assert.match(repositorySource, /providerErrors: completed\.providerErrors,/);
  assert.match(repositorySource, /providerErrors: \(row\.providerErrors as/);
});

test("the database has a durable provider_errors column, added via a real migration", () => {
  assert.match(schemaSource, /providerErrors: jsonb\("provider_errors"\)/);
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS provider_errors jsonb NOT NULL/);
});

test("the AI visibility settings API exposes scan history, not just the single latest scan", () => {
  assert.match(routeSource, /listAiVisibilityScans\(actor\.workspaceId, 8\)/);
  assert.match(routeSource, /recentScans/);
});
