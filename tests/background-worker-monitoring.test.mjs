import assert from "node:assert/strict";
import test from "node:test";

import {
  claimJob,
  createMonitoringScanRecord,
  isMonitoringCandidateDue,
  monitoringConfiguration,
  monitoringDedupeKey,
  scheduleMonitoringScans,
} from "../scripts/background-worker.mjs";

const NOW = new Date("2026-08-05T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

test("monitoring configuration has launch defaults and bounded overrides", () => {
  assert.deepEqual(monitoringConfiguration({}), {
    passIntervalHours: 24,
    coreIntervalMinutes: 360,
    passIntervalMs: DAY_MS,
    coreIntervalMs: 6 * 60 * 60 * 1_000,
    schedulerPollMs: 60_000,
  });
  assert.deepEqual(monitoringConfiguration({
    MONITOR_PASS_INTERVAL_HOURS: "12",
    MONITOR_CORE_INTERVAL_MINUTES: "90",
    MONITOR_SCHEDULER_POLL_MS: "15000",
  }), {
    passIntervalHours: 12,
    coreIntervalMinutes: 90,
    passIntervalMs: 12 * 60 * 60 * 1_000,
    coreIntervalMs: 90 * 60 * 1_000,
    schedulerPollMs: 15_000,
  });
  assert.equal(monitoringConfiguration({ MONITOR_PASS_INTERVAL_HOURS: "0" }).passIntervalHours, 24);
  assert.equal(monitoringConfiguration({ MONITOR_CORE_INTERVAL_MINUTES: "999999" }).coreIntervalMinutes, 10_080);
  assert.equal(monitoringConfiguration({ MONITOR_SCHEDULER_POLL_MS: "50" }).schedulerPollMs, 1_000);
});

test("only due active paid schedules qualify, while Core survives browser-session expiry", () => {
  const configuration = monitoringConfiguration({});
  const duePass = {
    plan: "pass",
    status: "active",
    accessUntil: new Date(NOW.getTime() + DAY_MS).toISOString(),
    workspaceExpiresAt: new Date(NOW.getTime() + 2 * DAY_MS).toISOString(),
    enabled: true,
    nextRunAt: NOW,
    hasPendingScan: false,
  };
  assert.equal(isMonitoringCandidateDue(duePass, NOW, configuration), true);
  assert.equal(isMonitoringCandidateDue({ ...duePass, plan: "free" }, NOW, configuration), false);
  assert.equal(isMonitoringCandidateDue({ ...duePass, status: "expired" }, NOW, configuration), false);
  assert.equal(isMonitoringCandidateDue({ ...duePass, status: "canceled" }, NOW, configuration), false);
  assert.equal(isMonitoringCandidateDue({ ...duePass, accessUntil: NOW }, NOW, configuration), false);
  assert.equal(isMonitoringCandidateDue({ ...duePass, workspaceExpiresAt: NOW }, NOW, configuration), false);
  assert.equal(isMonitoringCandidateDue({ ...duePass, enabled: false }, NOW, configuration), false);
  assert.equal(isMonitoringCandidateDue({ ...duePass, hasPendingScan: true }, NOW, configuration), false);
  assert.equal(isMonitoringCandidateDue({
    ...duePass,
    nextRunAt: new Date(NOW.getTime() + 1).toISOString(),
  }, NOW, configuration), false);

  const dueCore = {
    ...duePass,
    plan: "core",
    // Core eligibility follows verified active subscription state. Unlike the
    // fixed seven-day pass, it does not require a future accessUntil value.
    accessUntil: new Date(NOW.getTime() - DAY_MS).toISOString(),
    workspaceExpiresAt: new Date(NOW.getTime() - DAY_MS).toISOString(),
  };
  assert.equal(isMonitoringCandidateDue(dueCore, NOW, configuration), true);
  assert.equal(isMonitoringCandidateDue({ ...dueCore, status: "canceled" }, NOW, configuration), false);
});

test("monitoring dedupe keys are stable within a plan interval bucket", () => {
  const configuration = monitoringConfiguration({
    MONITOR_PASS_INTERVAL_HOURS: "1",
    MONITOR_CORE_INTERVAL_MINUTES: "60",
  });
  const first = monitoringDedupeKey("ws_example", "pass", "2026-08-05T12:05:00Z", configuration);
  const sameBucket = monitoringDedupeKey("ws_example", "pass", "2026-08-05T12:59:59Z", configuration);
  const nextBucket = monitoringDedupeKey("ws_example", "pass", "2026-08-05T13:00:00Z", configuration);
  assert.equal(first, sameBucket);
  assert.notEqual(first, nextBucket);
  assert.notEqual(
    first,
    monitoringDedupeKey("ws_example", "core", "2026-08-05T12:05:00Z", configuration),
  );
});

test("scheduled monitoring records exactly match the ScanRecord stage contract", () => {
  assert.deepEqual(createMonitoringScanRecord({
    scanId: "scan_fixed",
    workspaceId: "ws_fixed",
    websiteUrl: "https://example.com/",
    now: NOW,
  }), {
    id: "scan_fixed",
    workspaceId: "ws_fixed",
    websiteUrl: "https://example.com/",
    status: "queued",
    progress: [
      {
        id: "website",
        label: "Understanding your business",
        status: "pending",
        detail: "Reading safe public pages on the submitted domain.",
      },
      {
        id: "understanding",
        label: "Mapping the problems you solve",
        status: "pending",
        detail: "Building a source-backed product, audience and problem profile.",
      },
      {
        id: "discovery",
        label: "Searching recent Reddit conversations",
        status: "pending",
        detail: "Looking only inside the current seven-day scan window.",
      },
      {
        id: "reading",
        label: "Reading relevant posts and replies",
        status: "pending",
        detail: "Checking context, problem fit and source quality.",
      },
      {
        id: "ranking",
        label: "Identifying potential customers",
        status: "pending",
        detail: "Removing noise and deduplicating qualified people by Reddit author.",
      },
      {
        id: "competitors",
        label: "Checking competitor frustrations",
        status: "pending",
        detail: "Verifying complaints and alternative-seeking signals from their sources.",
      },
      {
        id: "replies",
        label: "Ranking the strongest opportunities",
        status: "pending",
        detail: "Ordering the best fits and preparing source-grounded replies.",
      },
    ],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    error: null,
    result: null,
  });
});

function createFakeSql(candidates, insertedJobResults) {
  const calls = [];
  let began = 0;
  let jobInsert = 0;
  const transactionSql = async (strings, ...values) => {
    const query = strings.join("?").replace(/\s+/gu, " ").trim();
    calls.push({ query, values });
    if (query.startsWith("SELECT schedule.workspace_id")) return candidates;
    if (query.startsWith("INSERT INTO background_jobs")) {
      const result = insertedJobResults[jobInsert] ?? [];
      jobInsert += 1;
      return result;
    }
    if (query.startsWith("INSERT INTO runtime_scans")) return [];
    if (query.startsWith("UPDATE runtime_monitoring_schedules")) return [];
    throw new Error(`Unexpected fake query: ${query}`);
  };
  transactionSql.json = (value) => value;
  const sql = {
    async begin(callback) {
      began += 1;
      return callback(transactionSql);
    },
  };
  return { calls, get began() { return began; }, sql };
}

test("scheduler reserves the deduped job and matching scan in one transaction", async () => {
  const candidates = [
    {
      workspace_id: "ws_pass",
      plan: "pass",
      entitlement_status: "active",
      access_until: new Date(NOW.getTime() + DAY_MS).toISOString(),
      workspace_expires_at: new Date(NOW.getTime() + 2 * DAY_MS),
      enabled: true,
      next_run_at: NOW,
      website_url: "https://pass.example/",
    },
    {
      workspace_id: "ws_core",
      plan: "core",
      entitlement_status: "active",
      access_until: null,
      workspace_expires_at: new Date(NOW.getTime() - DAY_MS),
      enabled: true,
      next_run_at: NOW,
      website_url: "https://core.example/",
    },
  ];
  const fake = createFakeSql(candidates, [[{ id: "job_one" }], []]);
  const scanIds = ["scan_first", "scan_duplicate"];
  const result = await scheduleMonitoringScans(fake.sql, {
    now: NOW,
    configuration: monitoringConfiguration({}),
    createScanId: () => scanIds.shift(),
    maxAttempts: 7,
  });

  assert.equal(fake.began, 1);
  assert.equal(result.candidateCount, 2);
  assert.equal(result.scheduled.length, 1);
  assert.equal(result.scheduled[0].scanId, "scan_first");
  assert.equal(result.deduplicated, 1);
  assert.deepEqual(fake.calls.map((call) => call.query.split(" ").slice(0, 3).join(" ")), [
    "SELECT schedule.workspace_id, entitlement.plan,",
    "INSERT INTO background_jobs",
    "INSERT INTO runtime_scans",
    "UPDATE runtime_monitoring_schedules SET",
    "INSERT INTO background_jobs",
  ]);

  const selectionQuery = fake.calls[0].query;
  assert.match(selectionQuery, /verified_event\.signature_verified = true/u);
  assert.match(selectionQuery, /schedule\.next_run_at <= \?/u);
  assert.match(selectionQuery, /seed_scan\.id = schedule\.seed_scan_id/u);
  assert.match(selectionQuery, /entitlement\.record ->> 'seedScanId' = schedule\.seed_scan_id/u);
  assert.match(selectionQuery, /schedule\.website_url = seed_scan\.website_url/u);
  assert.match(selectionQuery, /entitlement\.status = 'active'/u);
  assert.match(selectionQuery, /pending_scan\.status IN \('queued', 'running'\)/u);
  assert.match(selectionQuery, /seed_scan\.status = 'complete'/u);
  assert.match(selectionQuery, /entitlement\.plan = 'pass' AND workspace\.expires_at > \?/u);

  const jobPayload = fake.calls[1].values.find((value) => value?.scanId === "scan_first");
  const scanRecord = fake.calls[2].values.find((value) => value?.id === "scan_first");
  assert.deepEqual(jobPayload, { scanId: "scan_first", workspaceId: "ws_pass" });
  assert.equal(scanRecord.workspaceId, "ws_pass");
  assert.equal(scanRecord.websiteUrl, "https://pass.example/");
  assert.equal(scanRecord.status, "queued");
});

test("a scan insert failure aborts the transaction that reserved its job", async () => {
  let rolledBack = false;
  let queryIndex = 0;
  const transactionSql = async (strings) => {
    const query = strings.join("?").replace(/\s+/gu, " ").trim();
    queryIndex += 1;
    if (query.startsWith("SELECT schedule.workspace_id")) {
      return [{
        workspace_id: "ws_core",
        plan: "core",
        entitlement_status: "active",
        access_until: null,
        workspace_expires_at: new Date(NOW.getTime() - DAY_MS),
        enabled: true,
        next_run_at: NOW,
        website_url: "https://core.example/",
      }];
    }
    if (query.startsWith("INSERT INTO background_jobs")) return [{ id: "job_reserved" }];
    if (query.startsWith("INSERT INTO runtime_scans")) throw new Error("scan write failed");
    throw new Error(`Unexpected query ${queryIndex}: ${query}`);
  };
  transactionSql.json = (value) => value;
  const sql = {
    async begin(callback) {
      try {
        return await callback(transactionSql);
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    },
  };

  await assert.rejects(
    scheduleMonitoringScans(sql, {
      now: NOW,
      configuration: monitoringConfiguration({}),
      createScanId: () => "scan_will_rollback",
    }),
    /scan write failed/u,
  );
  assert.equal(rolledBack, true);
  assert.equal(queryIndex, 3);
});

test("job claiming never reclaims a job at its maximum attempt count", async () => {
  let query = "";
  const sql = async (strings) => {
    query = strings.join("?").replace(/\s+/gu, " ").trim();
    return [];
  };
  assert.equal(await claimJob(sql, "worker_test"), null);
  assert.match(query, /attempts < max_attempts/u);
});
