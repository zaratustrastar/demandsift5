import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { loadTsModule } from "./helpers/load-ts-module.mjs";
import { scanWorkflowHarness } from "./helpers/scan-workflow-harness.mjs";
import { claimJob, refreshJobLease, completeJob, failJob } from "../scripts/background-worker.mjs";

const databaseUrl = process.env.DEMANDSIFT_TEST_DATABASE_URL;
// Never fall back to DATABASE_URL: this suite is local and synthetic only.
if (databaseUrl && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(databaseUrl).hostname)) {
  throw new Error("DEMANDSIFT_TEST_DATABASE_URL must name a loopback-only test database.");
}
const now = () => new Date().toISOString();
const seed = () => ({ id: `scan_${randomUUID()}`, workspaceId: "fixture_workspace", websiteUrl: "", inputMode: "context",
  status: "queued", progress: [], result: null, error: null, createdAt: now(), updatedAt: now() });
const owner = job => ({ token: randomUUID(), jobId: job.id, attempt: job.attempts, workerId: job.locked_by });

test("PostgreSQL execution fencing, immutable checkpoints and claimed-attempt recovery", { skip: !databaseUrl }, async t => {
  const schemaName = `ds_scan_test_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(databaseUrl, { max: 1 });
  await admin`create schema ${admin(schemaName)}`;
  const sql = postgres(databaseUrl, { max: 8, prepare: false, connection: { search_path: schemaName } });
  const ormSql = postgres(databaseUrl, { max: 8, prepare: false, connection: { search_path: schemaName } });
  const globalKey = `postgresFixture_${randomUUID().replaceAll("-", "")}`;
  globalThis[globalKey] = drizzle(ormSql);
  t.after(async () => {
    delete globalThis[globalKey];
    await sql.end();
    await ormSql.end();
    // Only this randomly generated schema, never user tables or a database.
    await admin`drop schema ${admin(schemaName)} cascade`;
    await admin.end();
  });
  const ddl = await readFile(new URL("../db/migrations/0001_reddit_demand_intelligence.sql", import.meta.url), "utf8");
  await sql.unsafe(ddl.match(/CREATE TYPE job_status[^;]+;/u)[0]);
  await sql.unsafe("CREATE TABLE workspaces (id uuid PRIMARY KEY); CREATE TABLE businesses (id uuid PRIMARY KEY);");
  await sql.unsafe(ddl.match(/CREATE TABLE background_jobs \([\s\S]*?CREATE INDEX background_jobs_poll_idx[^;]+;/u)[0]);
  const runtime = await readFile(new URL("../db/migrations/0002_runtime_state.sql", import.meta.url), "utf8");
  await sql.begin(tx => tx.unsafe(runtime.replace(/^BEGIN;\s*/u, "").replace(/COMMIT;\s*$/u, "")));
  const providerCapacityDdl = await readFile(new URL("../db/migrations/0011_provider_capacity_leases.sql", import.meta.url), "utf8");
  await sql.begin(tx => tx.unsafe(providerCapacityDdl.replace(/^BEGIN;\s*/u, "").replace(/COMMIT;\s*$/u, "")));
  // Additive 0010 column; auth/account tables are outside this fixture's scope.
  await sql.unsafe("ALTER TABLE runtime_workspaces ADD COLUMN user_id uuid;");
  const { PostgresStateRepository } = await loadTsModule("lib/server/repository.ts", { moduleSources: {
    "db/index.ts": `export const getDb = () => globalThis[${JSON.stringify(globalKey)}];`,
  } });
  const { PostgresProviderCapacity } = await loadTsModule("lib/server/provider-capacity.ts", { moduleSources: {
    "db/index.ts": `export const getDb = () => globalThis[${JSON.stringify(globalKey)}];`,
  } });
  const a = new PostgresStateRepository(), b = new PostgresStateRepository();
  await a.saveWorkspace({ id: "fixture_workspace", tokenHash: "synthetic", expiresAt: new Date(Date.now() + 3600000).toISOString(), createdAt: now() });
  async function claimed(worker = "worker_a") {
    const scan = seed(); await a.saveScan(scan); await a.enqueueScan(scan.id, scan.workspaceId);
    const job = await claimJob(sql, worker); assert.ok(job);
    const execution = owner(job);
    const claim = await a.beginScanRun(scan.id, execution);
    assert.equal(claim.state, "claimed");
    return { scan: claim.scan, job, execution };
  }
  async function finish(job) { await completeJob(sql, job, job.locked_by); }

  await t.test("compact status projects PostgreSQL JSON fields and fences workspace access", async () => {
    const first = await claimed();
    first.scan.websiteSnapshot = { raw: "large_crawl_sentinel".repeat(50000) };
    first.scan.result = { raw: "large_report_sentinel".repeat(50000) };
    first.scan.contextText = "private_context_sentinel";
    first.scan.discoveryProfile = { profileStage: "full", business: { raw: "business_sentinel" } };
    first.scan.partialResults = { schemaVersion: 1, version: 2, updatedAt: "2026-08-31T12:00:00Z",
      previews: {}, qualified: {}, replies: {}, tombstones: [] };
    first.scan.phase = "analyzing";
    const { runtimeProgress, recordScanWork } = await loadTsModule("lib/server/scan-progress.ts");
    runtimeProgress(first.scan); recordScanWork(first.scan, "2026-08-31T12:00:01Z");
    await a.saveScan(first.scan, first.execution);
    await sql`update runtime_scans set record = jsonb_set(record, '{execution,heartbeatAt}', to_jsonb('2026-08-31T12:10:00Z'::text)) where id = ${first.scan.id}`;
    const value = await b.getScanStatus(first.scan.id, first.scan.workspaceId);
    assert.equal(value.analysisReady, true); assert.equal(value.phase, "analyzing");
    assert.equal(value.runtimeProgress.heartbeatAt, "2026-08-31T12:10:00Z");
    assert.equal(value.runtimeProgress.lastWorkAt, "2026-08-31T12:00:01Z");
    const encoded = JSON.stringify(value);
    assert.doesNotMatch(encoded, /sentinel|execution|triageCheckpoint/); assert.ok(encoded.length < 3000);
    assert.equal(await b.getScanStatus(first.scan.id, "different_workspace"), null);
    assert.equal(await b.getScanStatus("missing_scan", first.scan.workspaceId), null);
    const partial = await b.getScanPartialResults(first.scan.id, first.scan.workspaceId);
    assert.equal(partial.partialResults.version, 2); assert.equal(partial.websiteUrl, first.scan.websiteUrl);
    assert.doesNotMatch(JSON.stringify(partial), /large_report|large_crawl|private_context|business_sentinel/);
    assert.equal(await b.getScanPartialResults(first.scan.id, "different_workspace"), null);
    await finish(first.job);
  });

  await t.test("completion notice acknowledgement is durable, idempotent and workspace fenced", async () => {
    const first = await claimed();
    first.scan.status = "complete";
    first.scan.phase = "complete";
    first.scan.completionNotice = { version: "scan-complete-v1", createdAt: now(), readAt: null };
    await a.saveScan(first.scan, first.execution);
    await finish(first.job);
    assert.equal(await a.acknowledgeScanCompletion(first.scan.id, "different_workspace", "scan-complete-v1"), null);
    const acknowledged = await a.acknowledgeScanCompletion(first.scan.id, first.scan.workspaceId, "scan-complete-v1");
    assert.ok(acknowledged.readAt);
    const repeated = await b.acknowledgeScanCompletion(first.scan.id, first.scan.workspaceId, "scan-complete-v1");
    assert.equal(repeated.readAt, acknowledged.readAt);
    assert.equal((await b.getScanStatus(first.scan.id, first.scan.workspaceId)).completionNotice.readAt, acknowledged.readAt);
  });

  await t.test("two workers cannot claim the same queued attempt", async () => {
    const scan = seed(); await a.saveScan(scan); await a.enqueueScan(scan.id, scan.workspaceId);
    const jobs = await Promise.all([claimJob(sql, "parallel_a"), claimJob(sql, "parallel_b")]);
    assert.equal(jobs.filter(Boolean).length, 1); await finish(jobs.find(Boolean));
  });
  await t.test("two lanes claim different jobs while preserving workspace fairness", async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await sql`
      INSERT INTO background_jobs (id, type, status, payload, attempts, max_attempts, run_at, created_at, updated_at)
      VALUES
        (${ids[0]}, 'scan.run', 'running', ${sql.json({ scanId: "active_a", workspaceId: "workspace_a" })}, 1, 5, now(), now(), now()),
        (${ids[1]}, 'scan.run', 'queued', ${sql.json({ scanId: "queued_a", workspaceId: "workspace_a" })}, 0, 5, now(), now(), now()),
        (${ids[2]}, 'scan.run', 'queued', ${sql.json({ scanId: "queued_b", workspaceId: "workspace_b" })}, 0, 5, now(), now(), now())
    `;
    await sql`update background_jobs set locked_at = now(), locked_by = 'already_running' where id = ${ids[0]}`;
    const fair = await claimJob(sql, "fair_worker");
    assert.equal(fair.payload.workspaceId, "workspace_b");
    await finish(fair);
    await sql`update background_jobs set status = 'succeeded', locked_at = null, locked_by = null where id = ${ids[0]}`;
    const remainingA = await claimJob(sql, "lane_a");
    assert.equal(remainingA.id, ids[1]);
    await finish(remainingA);
    const twoIds = [randomUUID(), randomUUID()];
    await sql`
      INSERT INTO background_jobs (id, type, status, payload, attempts, max_attempts, run_at, created_at, updated_at)
      VALUES
        (${twoIds[0]}, 'scan.run', 'queued', ${sql.json({ scanId: "queued_c", workspaceId: "workspace_c" })}, 0, 5, now(), now(), now()),
        (${twoIds[1]}, 'scan.run', 'queued', ${sql.json({ scanId: "queued_d", workspaceId: "workspace_d" })}, 0, 5, now(), now(), now())
    `;
    const two = await Promise.all([claimJob(sql, "parallel_one"), claimJob(sql, "parallel_two")]);
    assert.equal(two.filter(Boolean).length, 2);
    assert.equal(new Set(two.map(job => job.id)).size, 2);
    await Promise.all(two.filter(Boolean).map(job => finish(job)));
  });
  await t.test("interactive priority ages without starving scheduled work", async () => {
    const freshScheduled = randomUUID(), freshInteractive = randomUUID();
    await sql`
      INSERT INTO background_jobs (id, type, status, payload, attempts, max_attempts, run_at, created_at, updated_at)
      VALUES
        (${freshScheduled}, 'reddit_monitor_scan', 'queued', ${sql.json({ workspaceId: "scheduled_fresh" })}, 0, 5, now(), now(), now()),
        (${freshInteractive}, 'scan.run', 'queued', ${sql.json({ scanId: "interactive", workspaceId: "interactive" })}, 0, 5, now(), now(), now())
    `;
    const interactiveFirst = await claimJob(sql, "priority_worker", { agingSeconds: 60 });
    assert.equal(interactiveFirst.id, freshInteractive);
    await finish(interactiveFirst);
    await sql`update background_jobs set status = 'succeeded' where id = ${freshScheduled}`;

    const oldScheduled = randomUUID(), newAnalysis = randomUUID();
    await sql`
      INSERT INTO background_jobs (id, type, status, payload, attempts, max_attempts, run_at, created_at, updated_at)
      VALUES
        (${oldScheduled}, 'ai_visibility_scan', 'queued', ${sql.json({ workspaceId: "scheduled_old" })}, 0, 5, now(), now() - interval '1 hour', now()),
        (${newAnalysis}, 'scan.analyze', 'queued', ${sql.json({ scanId: "analysis", workspaceId: "analysis" })}, 0, 5, now(), now(), now())
    `;
    const agedFirst = await claimJob(sql, "aging_worker", { agingSeconds: 60 });
    assert.equal(agedFirst.id, oldScheduled);
    await finish(agedFirst);
    const reserved = await claimJob(sql, "reserved_worker", { selection: "interactive", agingSeconds: 60 });
    assert.equal(reserved.id, newAnalysis);
    await finish(reserved);
  });
  await t.test("leased provider permits enforce a cap, workspace fairness, fencing and crash expiry", async () => {
    const capacity = new PostgresProviderCapacity(globalThis[globalKey], 5);
    const base = { pool: "ai-request", limit: 2, leaseMs: 60_000 };
    const held = await capacity.acquire({ ...base, holderKey: "held_a", workspaceId: "workspace_a" });
    const heldOther = await capacity.acquire({ ...base, holderKey: "held_other", workspaceId: "workspace_c" });
    const waitingA = capacity.acquire({ ...base, holderKey: "waiting_a", workspaceId: "workspace_a" });
    while (Number((await sql`select count(*) as total from provider_capacity_waiters`)[0].total) < 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const waitingB = capacity.acquire({ ...base, holderKey: "waiting_b", workspaceId: "workspace_b" });
    while (Number((await sql`select count(*) as total from provider_capacity_waiters`)[0].total) < 2) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await heldOther.release();
    const winner = await Promise.race([
      waitingA.then(lease => ({ workspace: "a", lease })),
      waitingB.then(lease => ({ workspace: "b", lease })),
    ]);
    assert.equal(winner.workspace, "b");
    await winner.lease.release();
    const aLease = await waitingA;
    await aLease.release();
    await held.release();

    const oldOwner = await capacity.acquire({ ...base, holderKey: "reclaimed", workspaceId: "workspace_a" });
    const successor = await capacity.acquire({ ...base, holderKey: "reclaimed", workspaceId: "workspace_a" });
    assert.equal(await oldOwner.release(), false, "an old lease token must not release a successor's permit");
    assert.equal(await successor.release(), true);

    const crashed = await capacity.acquire({ ...base, holderKey: "crashed", workspaceId: "workspace_a" });
    await sql`update provider_capacity_leases set expires_at = now() - interval '1 second' where holder_key = 'crashed'`;
    const reclaimed = await capacity.acquire({ ...base, holderKey: "after_crash", workspaceId: "workspace_b" });
    assert.equal(await crashed.release(), false);
    assert.equal(await reclaimed.release(), true);
  });
  await t.test("the repository claim path also executes against PostgreSQL", async () => {
    const scan = seed(); await a.saveScan(scan); await a.enqueueScan(scan.id, scan.workspaceId);
    const job = await a.claimJob("repository_worker");
    assert.equal(job.payload.scanId, scan.id); assert.equal(job.attempts, 1);
    await a.completeJob(job.id, "repository_worker", job.attempts);
  });
  await t.test("a new claim fences old completion, failure, heartbeat, scan and reply writes", async () => {
    const first = await claimed();
    first.scan.triageCheckpoint = { first: { fixture: "saved" } };
    await a.saveScan(first.scan, first.execution);
    await sql`update background_jobs set locked_at = now() - interval '10 minutes' where id = ${first.job.id}`;
    const secondJob = await claimJob(sql, "worker_b"); assert.equal(secondJob.id, first.job.id);
    const secondOwner = owner(secondJob);
    const second = await b.beginScanRun(first.scan.id, secondOwner);
    assert.equal(second.state, "claimed"); assert.ok(second.scan.triageCheckpoint.first);
    assert.equal(await refreshJobLease(sql, first.job.id, "worker_a", first.job.attempts), false);
    await completeJob(sql, first.job, "worker_a");
    await failJob(sql, first.job, new Error("late failure"), undefined, "worker_a");
    assert.equal((await a.getJob(first.job.id)).status, "running");
    first.scan.status = "complete";
    await assert.rejects(a.saveScan(first.scan, first.execution), { code: "scan_ownership_lost" });
    await assert.rejects(a.refreshScanExecution(first.scan.id, first.execution), { code: "scan_ownership_lost" });
    await assert.rejects(a.saveReply({ id: "late_reply", scanId: first.scan.id, workspaceId: first.scan.workspaceId, status: "draft", createdAt: now(), updatedAt: now() }, first.execution), { code: "scan_ownership_lost" });
    second.scan.status = "complete"; await b.saveScan(second.scan, secondOwner); await finish(secondJob);
    assert.equal((await a.getScan(first.scan.id)).status, "complete");
  });
  await t.test("reusing a worker ID does not let an older attempt mutate its job", async () => {
    const first = await claimed("same_worker");
    await sql`update background_jobs set locked_at = now() - interval '10 minutes' where id = ${first.job.id}`;
    const next = await claimJob(sql, "same_worker"); assert.equal(next.attempts, first.job.attempts + 1);
    assert.equal(await refreshJobLease(sql, first.job.id, "same_worker", first.job.attempts), false);
    await a.completeJob(first.job.id, "same_worker", first.job.attempts);
    await a.failJob(first.job.id, "same_worker", "late", first.job.attempts);
    assert.equal((await a.getJob(first.job.id)).status, "running"); await finish(next);
  });
  await t.test("a second web executor waits for the execution lease, then resumes saved work", async () => {
    const first = await claimed();
    first.scan.triageCheckpoint = { kept: { fixture: true } }; await a.saveScan(first.scan, first.execution);
    const nextOwner = owner(first.job);
    assert.equal((await b.beginScanRun(first.scan.id, nextOwner)).state, "running");
    await sql`update runtime_scans set record = jsonb_set(record, '{execution,heartbeatAt}', to_jsonb('2000-01-01T00:00:00.000Z'::text)) where id = ${first.scan.id}`;
    const next = await b.beginScanRun(first.scan.id, nextOwner);
    assert.equal(next.state, "claimed"); assert.ok(next.scan.triageCheckpoint.kept);
    await assert.rejects(a.saveScan(first.scan, first.execution), { code: "scan_ownership_lost" }); await finish(first.job);
  });
  await t.test("concurrent callbacks preserve all accumulated fields and terminal state cannot regress", async () => {
    const { scan, job, execution } = await claimed();
    scan.triageCheckpoint = {};
    const writes = Array.from({ length: 20 }, (_, i) => {
      scan.triageCheckpoint[`candidate_${i}`] = { fixture: i };
      scan.error = `checkpoint_${i}`;
      return a.saveScan(scan, execution);
    });
    await Promise.all(writes);
    assert.equal(Object.keys((await b.getScan(scan.id)).triageCheckpoint).length, 20);
    assert.equal((await b.getScan(scan.id)).error, "checkpoint_19");
    scan.status = "complete"; await a.saveScan(scan, execution);
    scan.status = "running";
    await assert.rejects(a.saveScan(scan, execution), { code: "scan_ownership_lost" }); await finish(job);
  });
  await t.test("unfenced stale edits cannot overwrite active or newer data", async () => {
    const { scan, job, execution } = await claimed();
    await assert.rejects(b.saveScan(structuredClone(scan)), { code: "scan_write_conflict" });
    scan.status = "complete"; await a.saveScan(scan, execution); await finish(job);
    const old = await a.getScan(scan.id), fresh = await b.getScan(scan.id);
    fresh.error = "newer"; await b.saveScan(fresh);
    await assert.rejects(a.saveScan(old), { code: "scan_write_conflict" });
    assert.equal((await a.getScan(scan.id)).error, "newer");
  });
  await t.test("durable analysis survives executor replacement, deduplicates clicks and waits for exact review approval", async t => {
    const fixture = await scanWorkflowHarness(t, { analyzed: false });
    fixture.scan.reviewRequired = true; fixture.scan.phase = "created";
    await a.saveScan(fixture.scan); fixture.state.repository = a;
    let discoveries = 0, analyses = 0;
    const discover = fixture.state.reddit.discover, analyze = fixture.state.ai.analyzeBusinessFromContext;
    fixture.state.reddit.discover = async (...args) => { discoveries++; return discover(...args); };
    fixture.state.ai.analyzeBusinessFromContext = async (...args) => { analyses++; return analyze(...args); };
    const accepted = await Promise.all(Array.from({ length: 3 }, () => a.acceptScanJob(fixture.scan.id, fixture.scan.workspaceId, "scan.analyze")));
    assert.equal(new Set(accepted.map(row => row.job.id)).size, 1);
    const job = await claimJob(sql, "analysis_worker"); assert.equal(job.type, "scan.analyze");
    await fixture.workflow.runScan(fixture.scan.id, { stopAfterUnderstanding: true, jobId: job.id, jobWorkerId: job.locked_by, jobAttempts: job.attempts, jobMaxAttempts: job.max_attempts });
    const ready = await b.getScan(fixture.scan.id);
    assert.equal(ready.phase, "awaiting_review"); assert.ok(ready.analysisCompletedAt);
    assert.equal(ready.status, "queued"); assert.equal(ready.result, null); assert.equal(analyses, 1); assert.equal(discoveries, 0);
    const { scanReviewVersion } = await loadTsModule("lib/server/scan-lifecycle.ts");
    await assert.rejects(b.acceptScanJob(ready.id, ready.workspaceId, "scan.run", "old-version"), { code: "scan_review_changed" });
    assert.equal(Number((await sql`select count(*) as total from background_jobs where type = 'scan.run' and payload->>'scanId' = ${ready.id}`)[0].total), 0);
    const version = scanReviewVersion(ready);
    const approved = await Promise.all([a, b].map(repo => repo.acceptScanJob(ready.id, ready.workspaceId, "scan.run", version)));
    assert.equal(approved[0].job.id, approved[1].job.id);
    // User approval can race the analysis worker's final poll without erasing
    // its durable completion marker or launching another analysis.
    const afterApproval = await b.getScan(ready.id);
    assert.equal(afterApproval.phase, "scan_queued"); assert.equal(afterApproval.analysisCompletedAt, ready.analysisCompletedAt);
    await finish(job);
    const runJob = await claimJob(sql, "run_worker"); assert.equal(runJob.type, "scan.run");
    await assert.rejects(fixture.workflow.runScan(ready.id, { jobId: runJob.id, jobWorkerId: runJob.locked_by, jobAttempts: runJob.attempts, jobMaxAttempts: runJob.max_attempts }), error => error === fixture.stop);
    assert.equal(analyses, 1); assert.equal(discoveries, 1); await finish(runJob);
  });
});
