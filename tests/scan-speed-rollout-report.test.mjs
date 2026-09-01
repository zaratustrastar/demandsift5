import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import { durationMs, parseReportArguments, percentile, runReport, summarizeRolloutRows } from "../scripts/scan-speed-rollout-report.mjs";

const databaseUrl = process.env.DEMANDSIFT_TEST_DATABASE_URL;
if (databaseUrl && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(databaseUrl).hostname)) {
  throw new Error("DEMANDSIFT_TEST_DATABASE_URL must name a loopback-only test database.");
}

const time = minutes => new Date(Date.UTC(2026, 8, 1, 12, minutes)).toISOString();
const row = (overrides = {}) => ({
  status: "complete",
  reddit_provider: "harshmaur", ai_enabled: true, data_mode: "live", analysis_mode: "openai",
  analysis_accepted_at: time(0), analysis_finished_at: time(4),
  run_accepted_at: time(30), run_started_at: time(32), first_preview_at: time(35), first_result_at: time(36),
  first_qualified_at: time(37), finished_at: time(40),
  coverage_complete: true, discovery_complete: true, triage_complete: true,
  triage_unresolved: 0, deep_review_target: 8, deep_review_completed: 8, fetched_candidates: 250,
  qualified_people: 5, relevant_conversations: 12, replies_ready: 5, job_attempts: 1, estimated_cost_usd: "0.42",
  ...overrides,
});

test("rollout argument parser requires an explicit comparison window and two configurations", () => {
  const parsed = parseReportArguments(["--from", time(0), "--to", time(59), "--baseline-config", "base",
    "--candidate-config=candidate", "--minimum-sample", "40", "--label", "staging"]);
  assert.equal(parsed.minimumSample, 40);
  assert.equal(parsed.label, "staging");
  assert.throws(() => parseReportArguments(["--from", time(0)]), /required/);
  assert.throws(() => parseReportArguments(["--from", time(59), "--to", time(0), "--baseline-config", "a", "--candidate-config", "b"]), /from earlier/);
  assert.throws(() => parseReportArguments(["--from", time(0), "--to", time(59), "--baseline-config", "same", "--candidate-config", "same"]), /must differ/);
});

test("durations reject missing, invalid, and backwards timestamps", () => {
  assert.equal(durationMs(time(0), time(4)), 240_000);
  assert.equal(durationMs(null, time(4)), null);
  assert.equal(durationMs(time(4), time(0)), null);
  assert.equal(percentile([1, 2, 3, 4], 0.9), 4);
});

test("summary separates analysis, queue, processing, first result, and full scan latency", () => {
  const summary = summarizeRolloutRows([row()], { minimumSample: 30 });
  assert.equal(summary.latencyMs.analysisAcceptanceToReviewReady.p50, 4 * 60_000);
  assert.equal(summary.latencyMs.queueWait.p50, 2 * 60_000);
  assert.equal(summary.latencyMs.processingWorkerStartToFinal.p50, 8 * 60_000);
  assert.equal(summary.latencyMs.firstResultFromRunAcceptance.p50, 6 * 60_000);
  assert.equal(summary.latencyMs.firstPreviewFromRunAcceptance.p50, 5 * 60_000);
  assert.equal(summary.latencyMs.firstQualifiedFromRunAcceptance.p50, 7 * 60_000);
  assert.equal(summary.latencyMs.fullFromRunAcceptance.p50, 10 * 60_000);
  assert.equal(summary.etaPublication.eligible, false);
  assert.deepEqual(summary.evidenceModes, { providerBacked: true, redditProvider: { harshmaur: 1 },
    data: { live: 1 }, analysis: { openai: 1 } });
  assert.match(summary.etaPublication.reason, /found 1/);
});

test("user review dwell is not mixed into full scan latency", () => {
  const summary = summarizeRolloutRows([row({ analysis_finished_at: time(4), run_accepted_at: time(50),
    run_started_at: time(52), first_result_at: time(55), finished_at: time(59) })], { minimumSample: 1 });
  assert.equal(summary.latencyMs.analysisAcceptanceToReviewReady.p50, 4 * 60_000);
  assert.equal(summary.latencyMs.fullFromRunAcceptance.p50, 9 * 60_000);
  assert.notEqual(summary.latencyMs.fullFromRunAcceptance.p50, 59 * 60_000);
});

test("failures, incomplete coverage, retries, depth and cost remain visible", () => {
  const summary = summarizeRolloutRows([
    row(),
    row({ status: "failed", finished_at: null, first_result_at: null, coverage_complete: false,
      discovery_complete: false, triage_complete: false, triage_unresolved: 7, deep_review_completed: 2,
      job_attempts: 3, estimated_cost_usd: "0.18" }),
    row({ status: "running", finished_at: null, job_attempts: 1, estimated_cost_usd: "99" }),
  ], { minimumSample: 1 });
  assert.equal(summary.sampleSize, 2);
  assert.equal(summary.observedRows, 3);
  assert.deepEqual(summary.terminal, { complete: 1, failed: 1, nonterminalExcluded: 1, completionRate: 0.5 });
  assert.equal(summary.quality.coverageCompleteRate, 0.5);
  assert.equal(summary.quality.triageComplete, 1);
  assert.equal(summary.quality.deepReviewCompleted.observations, 2);
  assert.equal(summary.retries.scansWithRetry, 1);
  assert.equal(summary.estimatedCostUsd.knownObservations, 2);
  assert.equal(summary.estimatedCostUsd.totalKnown, 0.6);
});

test("ETA eligibility requires the configured same-version sample floor", () => {
  const below = summarizeRolloutRows(Array.from({ length: 29 }, () => row()), { minimumSample: 30 });
  const enough = summarizeRolloutRows(Array.from({ length: 30 }, (_, index) => row({ finished_at: time(40 + (index % 4)) })), { minimumSample: 30 });
  assert.equal(below.etaPublication.eligible, false);
  assert.equal(enough.etaPublication.eligible, true);
  assert.equal(enough.etaPublication.sampleSize, 30);
  const mock = summarizeRolloutRows(Array.from({ length: 30 }, () => row({ reddit_provider: "mock", data_mode: "mock" })), { minimumSample: 30 });
  assert.equal(mock.etaPublication.eligible, false);
  assert.match(mock.etaPublication.reason, /provider-backed/);
});

test("unknown numeric observations are omitted instead of becoming zero", () => {
  const summary = summarizeRolloutRows([row({ deep_review_target: null, job_attempts: null, estimated_cost_usd: null })], { minimumSample: 1 });
  assert.equal(summary.quality.deepReviewTarget.observations, 0);
  assert.equal(summary.retries.attempts.observations, 0);
  assert.equal(summary.estimatedCostUsd.perScan.observations, 0);
  assert.equal(summary.estimatedCostUsd.knownObservations, 0);
});

test("read-only report query projects aggregate-safe fields from PostgreSQL", { skip: !databaseUrl }, async t => {
  const schemaName = `ds_rollout_report_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(databaseUrl, { max: 1 });
  await admin`CREATE SCHEMA ${admin(schemaName)}`;
  const sql = postgres(databaseUrl, { max: 1, prepare: false, connection: { search_path: schemaName } });
  t.after(async () => {
    await sql.end();
    await admin`DROP SCHEMA ${admin(schemaName)} CASCADE`;
    await admin.end();
  });
  await sql.unsafe(`
    CREATE TABLE runtime_scans (id varchar(96) PRIMARY KEY, status varchar(24) NOT NULL, record jsonb NOT NULL, created_at timestamptz NOT NULL);
    CREATE TABLE background_jobs (type varchar(100) NOT NULL, payload jsonb NOT NULL, attempts integer NOT NULL, created_at timestamptz NOT NULL);
  `);
  const record = (configId, minutes) => ({ scanKind: "discovery",
    runConfiguration: { id: configId, aiEnabled: true, environment: { REDDIT_PROVIDER: "harshmaur" } },
    durableJob: { type: "scan.run", acceptedAt: time(30) }, timing: { firstPreviewAt: time(35), firstResultAt: time(36),
      firstQualifiedAt: time(37), finishedAt: time(minutes) },
    runtimeProgress: { acceptedAt: time(0), analysisFinishedAt: time(4), runStartedAt: time(32), finishedAt: time(minutes),
      coverageComplete: true, discoveryComplete: true, triageComplete: true, triage: { unresolved: 0 },
      deepReview: { target: 8, completed: 8 }, fetched: 250,
      results: { qualifiedPeople: 5, relevantConversations: 12, repliesReady: 5 } },
    result: { dataMode: "live", analysisMode: "openai", usage: [{ estimatedCostUsd: 0.42 }] } });
  await sql`INSERT INTO runtime_scans (id, status, record, created_at) VALUES
    ('scan_base', 'complete', ${sql.json(record("base", 42))}, ${time(0)}),
    ('scan_candidate', 'complete', ${sql.json(record("candidate", 40))}, ${time(0)})`;
  await sql`INSERT INTO background_jobs (type, payload, attempts, created_at) VALUES
    ('scan.run', ${sql.json({ scanId: "scan_base" })}, 2, ${time(30)}),
    ('scan.run', ${sql.json({ scanId: "scan_candidate" })}, 1, ${time(30)})`;
  const options = { from: new Date(Date.UTC(2026, 8, 1, 11, 0)).toISOString(), to: new Date(Date.UTC(2026, 8, 1, 14, 0)).toISOString(),
    baselineConfig: "base", candidateConfig: "candidate", minimumSample: 1, label: "local-fixture" };
  const report = await runReport(options, databaseUrl, { search_path: schemaName });
  assert.equal(report.kind, "database_observations");
  assert.equal(report.providerBacked, true);
  assert.equal(report.reviewDwellIncluded, false);
  assert.equal(report.baseline.sampleSize, 1);
  assert.equal(report.baseline.retries.scansWithRetry, 1);
  assert.equal(report.candidate.latencyMs.fullFromRunAcceptance.p50, 10 * 60_000);
  assert.equal(report.candidate.estimatedCostUsd.totalKnown, 0.42);
});
