import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./helpers/load-ts-module.mjs";

test("built API requires reviewed approval, preserves context flow and private ownership", async t => {
  const previous = { ...process.env };
  for (const name of ["DATABASE_URL", "OPENAI_API_KEY", "OPENAI_DIRECT_FALLBACK_API_KEY", "APIFY_TOKEN", "BACKGROUND_WORKER_MODE"]) delete process.env[name];
  Object.assign(process.env, { APP_RUNTIME_ENV: "test", STATE_STORE: "memory", REDDIT_PROVIDER: "mock", SCAN_PARTIAL_RESULTS: "1" });
  t.after(() => {
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
  });
  const { default: server } = await import("../dist/server/index.js");
  async function request(path, { method = "GET", body, cookie } = {}) {
    const response = await server(new Request(`http://localhost${path}`, { method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    return { response, value: await response.json() };
  }
  const create = await request("/api/scans", { method: "POST", body: {
    contextText: "Synthetic API test business: tools to find missing client documents and track project deadlines.", reviewFirst: true,
  } });
  assert.equal(create.response.status, 201);
  const cookie = create.response.headers.get("set-cookie").split(";")[0], id = create.value.scan.id;
  assert.equal(create.value.scan.phase, "created"); assert.equal(create.value.report, null);
  const run = body => request(`/api/scans/${id}/run`, { method: "POST", cookie, body });
  const tooEarly = await run({ reviewVersion: "unknown" });
  assert.equal(tooEarly.response.status, 409); assert.equal(tooEarly.value.error.code, "scan_review_required");
  const analyzed = await request(`/api/scans/${id}/analyze`, { method: "POST", cookie });
  assert.equal(analyzed.response.status, 200); assert.equal(analyzed.value.scan.phase, "awaiting_review");
  assert.equal(analyzed.value.scan.status, "queued"); assert.equal(analyzed.value.report, null);
  assert.equal(analyzed.value.scan.durable, false);
  const restored = await request(`/api/scans/${id}`, { cookie });
  assert.equal(restored.value.scan.inputMode, "context");
  assert.equal(restored.value.scan.contextText, create.value.scan.contextText);
  const status = await request(`/api/scans/${id}?statusOnly=1`, { cookie });
  assert.equal(status.value.scan.phase, "awaiting_review"); assert.ok(status.value.access);
  assert.equal(status.response.headers.get("cache-control"), "private, no-store");
  assert.equal(status.value.scan.runtimeProgress.version, 1);
  assert.ok(status.value.scan.runtimeProgress.analysisStartedAt);
  assert.ok(status.value.scan.runtimeProgress.analysisFinishedAt);
  assert.equal(status.value.scan.runtimeProgress.runStartedAt, null);
  assert.equal(status.value.report, null);
  assert.equal(status.value.scan.contextText, undefined);
  const terms = await request(`/api/scans/${id}/discovery-terms`, { cookie });
  assert.ok(terms.value.reviewVersion); assert.equal(terms.value.profileStage, "full");
  const edited = await request(`/api/scans/${id}/discovery-terms`, { method: "PUT", cookie, body: { productTerms: ["client document tracker"] } });
  assert.equal(edited.response.status, 200); assert.notEqual(edited.value.reviewVersion, terms.value.reviewVersion);
  const stale = await run({ reviewVersion: terms.value.reviewVersion });
  assert.equal(stale.response.status, 409); assert.equal(stale.value.error.code, "scan_review_changed");
  const completed = await run({ reviewVersion: edited.value.reviewVersion });
  assert.equal(completed.response.status, 200); assert.equal(completed.value.scan.status, "complete");
  assert.ok(completed.value.report); assert.equal(completed.value.report.dataMode, "mock");
  const partial = await request(`/api/scans/${id}/partial?afterVersion=0`, { cookie });
  assert.equal(partial.response.status, 200);
  // Preview publishing is unconditional now (not gated by any scan-speed
  // flag): the plain sequential triage loop's own per-batch checkpoint
  // publishes candidate previews as it goes. This mock fixture's synthetic
  // candidates are all triaged as relevant, so a real snapshot is written.
  assert.equal(partial.value.changed, true); assert.equal(partial.value.version, 1);
  assert.equal(partial.value.partial.previews.length, 5);
  for (const preview of partial.value.partial.previews) {
    assert.equal(preview.kind, "candidate_preview");
    assert.equal(preview.qualificationStatus, "pending");
    assert.ok(preview.title); assert.ok(preview.subreddit); assert.ok(preview.intent);
  }
  assert.equal(partial.response.headers.get("cache-control"), "private, no-store");
  assert.equal((await request(`/api/scans/${id}/partial?afterVersion=${partial.value.version}`, { cookie })).value.changed, false);
  assert.equal((await request(`/api/scans/${id}/partial?afterVersion=bad`, { cookie })).response.status, 400);
  const finishedStatus = await request(`/api/scans/${id}?statusOnly=1`, { cookie });
  assert.ok(finishedStatus.value.scan.runtimeProgress.runStartedAt);
  assert.ok(finishedStatus.value.scan.runtimeProgress.finishedAt);
  assert.equal(finishedStatus.value.scan.runtimeProgress.triageComplete, true);
  assert.equal(finishedStatus.value.scan.runtimeProgress.deepReview.threadsVerified, 0, "mock threads are not actually fetched public threads");
  assert.equal(finishedStatus.value.report, null);
  const { scanResponseToDashboard } = await loadTsModule("components/demand-intelligence/from-scan.ts");
  assert.doesNotThrow(() => scanResponseToDashboard(completed.value));
  assert.equal((await run({ reviewVersion: edited.value.reviewVersion })).value.scan.id, id);
  const other = await request("/api/scans", { method: "POST", body: { contextText: "Another entirely synthetic workspace for an ownership check.", reviewFirst: true } });
  const otherCookie = other.response.headers.get("set-cookie").split(";")[0];
  assert.equal((await request(`/api/scans/${id}?statusOnly=1`, { cookie: otherCookie })).response.status, 404);
  assert.equal((await request(`/api/scans/${id}/partial?afterVersion=0`, { cookie: otherCookie })).response.status, 404);
  assert.equal((await request(`/api/scans/${id}/discovery-terms`, { cookie: otherCookie })).response.status, 404);
});
