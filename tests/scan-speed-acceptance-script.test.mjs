import assert from "node:assert/strict";
import test from "node:test";
import { acceptanceTestFiles, knownBaselineExclusions, sanitizedEnvironment } from "../scripts/scan-speed-acceptance.mjs";

test("local acceptance strips live credentials and forces mock providers", () => {
  const env = sanitizedEnvironment({ OPENAI_API_KEY: "paid", OPENAI_DIRECT_FALLBACK_API_KEY: "paid-fallback",
    APIFY_TOKEN: "paid-apify", DATABASE_URL: "production", DEMANDSIFT_REPORT_DATABASE_URL: "reporting",
    STRIPE_SECRET_KEY: "stripe", REDDIT_CLIENT_SECRET: "reddit", DEMANDSIFT_TEST_DATABASE_URL: "postgres://test@127.0.0.1:5432/test" });
  for (const key of ["OPENAI_API_KEY", "OPENAI_DIRECT_FALLBACK_API_KEY", "APIFY_TOKEN", "DATABASE_URL",
    "DEMANDSIFT_REPORT_DATABASE_URL", "STRIPE_SECRET_KEY", "REDDIT_CLIENT_SECRET"]) assert.equal(env[key], undefined);
  assert.equal(env.DEMANDSIFT_TEST_DATABASE_URL, "postgres://test@127.0.0.1:5432/test");
  assert.equal(env.APP_RUNTIME_ENV, "test");
  assert.equal(env.REDDIT_PROVIDER, "mock");
});

test("local acceptance rejects a remote integration database", () => {
  assert.throws(() => sanitizedEnvironment({ DEMANDSIFT_TEST_DATABASE_URL: "postgres://user@example.com/production" }), /loopback-only/);
});

test("bounded gate excludes only the declared stale baseline and strict mode restores it", () => {
  const bounded = acceptanceTestFiles(), strict = acceptanceTestFiles({ strict: true });
  assert.deepEqual(knownBaselineExclusions, ["rendered-html.test.mjs"]);
  assert.ok(!bounded.includes("tests/rendered-html.test.mjs"));
  assert.ok(strict.includes("tests/rendered-html.test.mjs"));
  assert.equal(strict.length, bounded.length + 1);
  assert.ok(bounded.includes("tests/scan-rollout-cohort.test.mjs"));
  assert.ok(bounded.includes("tests/scan-speed-rollout-report.test.mjs"));
});
