#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { hostname } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import postgres from "postgres";

const workerId = `${hostname()}:${process.pid}`;
export const REDDIT_MONITOR_MAX_WATCH_TERMS = 5;

const MONITORING_STAGES = [
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
    detail: "Building a source-backed company context pack.",
  },
  {
    id: "discovery",
    label: "Searching recent Reddit conversations",
    status: "pending",
    detail: "Searching explicit demand, pain, switching, recommendation and brand lanes.",
  },
  {
    id: "triage",
    label: "Reading every credible candidate",
    status: "pending",
    detail: "Using high-recall AI triage before spending on full thread context.",
  },
  {
    id: "enrichment",
    label: "Opening the strongest conversations",
    status: "pending",
    detail: "Fetching useful thread context only for candidates worth deeper review.",
  },
  {
    id: "qualification",
    label: "Identifying potential customers",
    status: "pending",
    detail: "Qualifying first, then ranking and deduplicating people by Reddit author.",
  },
  {
    id: "replies",
    label: "Preparing the best next move",
    status: "pending",
    detail: "Generating one grounded reply only when the conversation is appropriate to join.",
  },
];

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(minimum, Math.min(parsed, maximum))
    : fallback;
}

/**
 * Recurring monitoring is off for the MVP, which is a single user-triggered
 * 7-day scan. The scheduler machinery is retained (nothing enrols scans into
 * `runtime_monitoring_schedules` today, so it is dormant either way) but it no
 * longer starts unless explicitly enabled, so the guarantee is enforced rather
 * than incidental.
 */
export function monitoringSchedulerEnabled(environment = process.env) {
  return String(environment.MONITORING_SCHEDULER_ENABLED ?? "").trim().toLowerCase() === "true";
}

/** Daily watch-term monitoring is independent from the legacy full-scan scheduler. */
export function redditMonitorSchedulerEnabled(environment = process.env) {
  return String(environment.REDDIT_MONITOR_SCHEDULER_ENABLED ?? "true")
    .trim()
    .toLowerCase() !== "false";
}

export function redditMonitorConfiguration(environment = process.env) {
  return {
    schedulerPollMs: boundedNumber(
      environment.REDDIT_MONITOR_SCHEDULER_POLL_MS,
      60_000,
      1_000,
      900_000,
    ),
    firstLookbackHours: boundedNumber(
      environment.REDDIT_MONITOR_FIRST_LOOKBACK_HOURS,
      24,
      1,
      168,
    ),
  };
}

export function redditMonitorDedupeKey(workspaceId, now) {
  const milliseconds = validTimestamp(now);
  if (!workspaceId || milliseconds === null) {
    throw new Error("A workspace and valid timestamp are required for Reddit monitoring.");
  }
  return `reddit-monitor:${workspaceId}:${new Date(milliseconds).toISOString().slice(0, 10)}`;
}

export function monitoringConfiguration(environment = process.env) {
  const passIntervalHours = boundedNumber(
    environment.MONITOR_PASS_INTERVAL_HOURS,
    24,
    1,
    168,
  );
  const coreIntervalMinutes = boundedNumber(
    environment.MONITOR_CORE_INTERVAL_MINUTES,
    360,
    5,
    10_080,
  );
  const schedulerPollMs = boundedNumber(
    environment.MONITOR_SCHEDULER_POLL_MS,
    60_000,
    1_000,
    900_000,
  );
  return {
    passIntervalHours,
    coreIntervalMinutes,
    passIntervalMs: passIntervalHours * 60 * 60 * 1_000,
    coreIntervalMs: coreIntervalMinutes * 60 * 1_000,
    schedulerPollMs,
  };
}

function intervalForPlan(plan, configuration) {
  if (plan === "pass") return configuration.passIntervalMs;
  if (plan === "core") return configuration.coreIntervalMs;
  return null;
}

function validTimestamp(value) {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ""));
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

export function isMonitoringCandidateDue(candidate, now, configuration) {
  const nowMs = validTimestamp(now);
  const nextRunAt = validTimestamp(candidate.nextRunAt);
  const intervalMs = intervalForPlan(candidate.plan, configuration);
  if (
    nowMs === null ||
    nextRunAt === null ||
    intervalMs === null ||
    candidate.status !== "active" ||
    candidate.enabled !== true ||
    candidate.hasPendingScan ||
    nextRunAt > nowMs
  ) {
    return false;
  }
  if (candidate.plan === "pass") {
    const accessUntil = validTimestamp(candidate.accessUntil);
    const workspaceExpiresAt = validTimestamp(candidate.workspaceExpiresAt);
    if (
      accessUntil === null ||
      accessUntil <= nowMs ||
      workspaceExpiresAt === null ||
      workspaceExpiresAt <= nowMs
    ) return false;
  }
  return true;
}

export function monitoringDedupeKey(workspaceId, plan, now, configuration) {
  const nowMs = validTimestamp(now);
  const intervalMs = intervalForPlan(plan, configuration);
  if (nowMs === null || intervalMs === null) {
    throw new Error("A valid monitoring plan, timestamp, and interval are required.");
  }
  const bucket = Math.floor(nowMs / intervalMs);
  return `monitor:${workspaceId}:${plan}:${intervalMs}:${bucket}`;
}

export function createMonitoringScanRecord({ scanId, workspaceId, websiteUrl, now }) {
  const nowMs = validTimestamp(now);
  if (!scanId || !workspaceId || !websiteUrl || nowMs === null) {
    throw new Error("A scan ID, workspace ID, website URL, and timestamp are required.");
  }
  const timestamp = new Date(nowMs).toISOString();
  return {
    id: scanId,
    workspaceId,
    websiteUrl,
    status: "queued",
    progress: MONITORING_STAGES.map((stage) => ({ ...stage })),
    createdAt: timestamp,
    updatedAt: timestamp,
    error: null,
    result: null,
  };
}

function log(level, event, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    component: "background-worker",
    event,
    workerId,
    ...details,
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function psqlIncludePath(value) {
  if (value.includes("'") || /[\r\n]/u.test(value)) {
    throw new Error("Migration paths may not contain quotes or newlines.");
  }
  return `'${value}'`;
}

function runPsql(databaseUrl, input, label) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      "psql",
      ["--dbname", databaseUrl, "--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--quiet"],
      {
        env: process.env,
        stdio: ["pipe", "inherit", "inherit"],
      },
    );

    child.once("error", (error) => {
      rejectPromise(new Error(`Could not start psql for ${label}: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        rejectPromise(
          new Error(
            `psql failed during ${label} (${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}).`,
          ),
        );
      }
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") rejectPromise(error);
    });
    child.stdin.end(input);
  });
}

async function verifyDatabase(databaseUrl) {
  await runPsql(databaseUrl, "SELECT 1;\n", "database connectivity check");
  log("info", "database_ready");
}

async function runMigrations() {
  const databaseUrl = requiredEnvironment("DATABASE_URL");
  const configuredDirectory = process.env.MIGRATIONS_DIR?.trim() || "db/migrations";
  const migrationsDirectory = isAbsolute(configuredDirectory)
    ? configuredDirectory
    : resolve(process.cwd(), configuredDirectory);
  const migrationNames = (await readdir(migrationsDirectory))
    .filter((name) => /^\d[^/]*\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right, "en"));

  if (migrationNames.length === 0) {
    throw new Error(`No SQL migrations were found in ${migrationsDirectory}.`);
  }

  const statements = [
    "\\set ON_ERROR_STOP on",
    "SELECT pg_advisory_lock(hashtextextended('threadline:schema-migrations', 0));",
    "CREATE TABLE IF NOT EXISTS threadline_schema_migrations (",
    "  migration_name text PRIMARY KEY,",
    "  checksum_sha256 char(64) NOT NULL,",
    "  applied_at timestamptz NOT NULL DEFAULT now()",
    ");",
  ];

  for (const migrationName of migrationNames) {
    const migrationPath = resolve(migrationsDirectory, migrationName);
    const contents = await readFile(migrationPath);
    const checksum = createHash("sha256").update(contents).digest("hex");
    const nameLiteral = sqlLiteral(migrationName);
    const checksumLiteral = sqlLiteral(checksum);

    statements.push(
      `SELECT EXISTS (SELECT 1 FROM threadline_schema_migrations WHERE migration_name = ${nameLiteral}) AS migration_known,`,
      `       EXISTS (SELECT 1 FROM threadline_schema_migrations WHERE migration_name = ${nameLiteral} AND checksum_sha256 = ${checksumLiteral}) AS migration_exact \\gset`,
      "\\if :migration_known",
      "  \\if :migration_exact",
      `    \\echo 'Already applied: ${migrationName}'`,
      "  \\else",
      `    \\echo 'ERROR: checksum changed for applied migration ${migrationName}'`,
      "    \\quit 3",
      "  \\endif",
      "\\else",
      `  \\echo 'Applying: ${migrationName}'`,
      `  \\i ${psqlIncludePath(migrationPath)}`,
      `  INSERT INTO threadline_schema_migrations (migration_name, checksum_sha256) VALUES (${nameLiteral}, ${checksumLiteral});`,
      "\\endif",
    );
  }

  statements.push(
    "SELECT pg_advisory_unlock(hashtextextended('threadline:schema-migrations', 0));",
  );

  log("info", "migrations_started", { count: migrationNames.length });
  await runPsql(databaseUrl, `${statements.join("\n")}\n`, "schema migrations");
  log("info", "migrations_completed", { count: migrationNames.length });
}

function createShutdownController() {
  const controller = new AbortController();
  const requestShutdown = (signal) => {
    if (!controller.signal.aborted) {
      log("info", "shutdown_requested", { signal });
      controller.abort(signal);
    }
  };
  process.once("SIGTERM", () => requestShutdown("SIGTERM"));
  process.once("SIGINT", () => requestShutdown("SIGINT"));
  return controller;
}

async function waitInStandby(signal) {
  if (signal.aborted) return;
  const configuredInterval = Number(process.env.WORKER_HEARTBEAT_SECONDS ?? 60);
  const heartbeatSeconds = Number.isFinite(configuredInterval)
    ? Math.max(15, Math.min(configuredInterval, 900))
    : 60;
  const interval = setInterval(
    () => log("info", "standby_heartbeat", { processingJobs: false }),
    heartbeatSeconds * 1_000,
  );

  await new Promise((resolvePromise) => {
    signal.addEventListener("abort", resolvePromise, { once: true });
  });
  clearInterval(interval);
}

async function runModuleWorker(signal) {
  const configuredModule = requiredEnvironment("BACKGROUND_WORKER_MODULE");
  if (/^[a-z][a-z0-9+.-]*:/iu.test(configuredModule) && !configuredModule.startsWith("file:")) {
    throw new Error("BACKGROUND_WORKER_MODULE must reference a local file, not a remote URL.");
  }
  const moduleUrl = configuredModule.startsWith("file:")
    ? configuredModule
    : pathToFileURL(resolve(process.cwd(), configuredModule)).href;
  const loaded = await import(moduleUrl);
  const start = loaded.startBackgroundWorker ?? loaded.default;
  if (typeof start !== "function") {
    throw new Error(
      "The worker module must export `startBackgroundWorker` or a default async function.",
    );
  }

  log("info", "module_worker_started", { module: configuredModule });
  await start({ signal, workerId, log });
  if (!signal.aborted) {
    throw new Error("The background worker module exited before shutdown was requested.");
  }
}

function waitForNextPoll(signal, delayMs) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timeout = setTimeout(resolvePromise, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolvePromise();
      },
      { once: true },
    );
  });
}

function internalWorkerUrl() {
  const configured = requiredEnvironment("INTERNAL_WEB_URL");
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("INTERNAL_WEB_URL must be a valid HTTP or HTTPS URL.");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new Error("INTERNAL_WEB_URL must be an HTTP(S) origin without credentials.");
  }
  return url.origin;
}

function configuredMaxAttempts() {
  const value = Number(process.env.BACKGROUND_JOB_MAX_ATTEMPTS ?? 5);
  return Number.isInteger(value) ? Math.max(1, Math.min(value, 20)) : 5;
}

/**
 * Atomically reserves a bucketed queue job and creates its matching scan.
 * The job is inserted first so a dedupe conflict never leaves an orphan scan;
 * both writes remain invisible until the enclosing transaction commits, and a
 * scan insert failure rolls the reserved job back.
 */
export async function scheduleMonitoringScans(
  sql,
  {
    now = new Date(),
    configuration = monitoringConfiguration(),
    createScanId = () => `scan_${randomUUID().replaceAll("-", "")}`,
    maxAttempts = configuredMaxAttempts(),
  } = {},
) {
  const nowMs = validTimestamp(now);
  if (nowMs === null) throw new Error("The monitoring scheduler timestamp is invalid.");
  const scheduledAt = new Date(nowMs);

  return sql.begin(async (transactionSql) => {
    const candidates = await transactionSql`
      SELECT schedule.workspace_id,
             entitlement.plan,
             entitlement.status AS entitlement_status,
             entitlement.record ->> 'accessUntil' AS access_until,
             workspace.expires_at AS workspace_expires_at,
             schedule.enabled,
             schedule.next_run_at,
             seed_scan.website_url
      FROM runtime_monitoring_schedules AS schedule
      JOIN runtime_entitlements AS entitlement
        ON entitlement.workspace_id = schedule.workspace_id
      JOIN runtime_workspaces AS workspace
        ON workspace.id = schedule.workspace_id
      JOIN stripe_events AS verified_event
        ON verified_event.stripe_event_id = entitlement.record ->> 'verifiedByEventId'
       AND verified_event.signature_verified = true
       AND verified_event.processed_at IS NOT NULL
      JOIN runtime_scans AS seed_scan
        ON seed_scan.id = schedule.seed_scan_id
       AND seed_scan.workspace_id = schedule.workspace_id
       AND seed_scan.status = 'complete'
      WHERE schedule.enabled = true
        AND schedule.plan = entitlement.plan
        AND schedule.next_run_at <= ${scheduledAt}
        AND entitlement.status = 'active'
        AND entitlement.plan IN ('pass', 'core')
        AND entitlement.record ->> 'workspaceId' = entitlement.workspace_id
        AND entitlement.record ->> 'plan' = entitlement.plan
        AND entitlement.record ->> 'status' = entitlement.status
        AND entitlement.record ->> 'seedScanId' = schedule.seed_scan_id
        AND entitlement.record ->> 'websiteUrl' = schedule.website_url
        AND schedule.website_url = seed_scan.website_url
        AND length(trim(seed_scan.website_url)) > 0
        AND (
          (
            entitlement.plan = 'pass'
            AND workspace.expires_at > ${scheduledAt}
            AND jsonb_typeof(entitlement.record -> 'accessUntil') = 'string'
            AND NULLIF(entitlement.record ->> 'accessUntil', '')::timestamptz > ${scheduledAt}
          )
          OR entitlement.plan = 'core'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM runtime_scans AS pending_scan
          WHERE pending_scan.workspace_id = entitlement.workspace_id
            AND pending_scan.status IN ('queued', 'running')
        )
      ORDER BY schedule.next_run_at, schedule.workspace_id
      LIMIT 100
      FOR UPDATE OF schedule SKIP LOCKED
    `;

    const scheduled = [];
    let deduplicated = 0;
    for (const row of candidates) {
      const candidate = {
        workspaceId: row.workspace_id,
        plan: row.plan,
        status: row.entitlement_status,
        accessUntil: row.access_until,
        workspaceExpiresAt: row.workspace_expires_at,
        enabled: row.enabled,
        nextRunAt: row.next_run_at,
        hasPendingScan: false,
      };
      if (!isMonitoringCandidateDue(candidate, scheduledAt, configuration)) continue;

      const scanId = createScanId();
      const dedupeKey = monitoringDedupeKey(
        candidate.workspaceId,
        candidate.plan,
        scheduledAt,
        configuration,
      );
      const payload = { scanId, workspaceId: candidate.workspaceId };
      const insertedJobs = await transactionSql`
        INSERT INTO background_jobs (
          type,
          status,
          payload,
          dedupe_key,
          attempts,
          max_attempts,
          run_at,
          created_at,
          updated_at
        )
        VALUES (
          'scan.run',
          'queued',
          ${transactionSql.json(payload)},
          ${dedupeKey},
          0,
          ${maxAttempts},
          ${scheduledAt},
          ${scheduledAt},
          ${scheduledAt}
        )
        ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
        RETURNING id
      `;
      if (insertedJobs.length === 0) {
        deduplicated += 1;
        continue;
      }

      const record = createMonitoringScanRecord({
        scanId,
        workspaceId: candidate.workspaceId,
        websiteUrl: row.website_url,
        now: scheduledAt,
      });
      await transactionSql`
        INSERT INTO runtime_scans (
          id,
          workspace_id,
          website_url,
          status,
          record,
          created_at,
          updated_at
        )
        VALUES (
          ${record.id},
          ${record.workspaceId},
          ${record.websiteUrl},
          ${record.status},
          ${transactionSql.json(record)},
          ${scheduledAt},
          ${scheduledAt}
        )
      `;
      const intervalMs = intervalForPlan(candidate.plan, configuration);
      const nextRunAt = new Date(nowMs + intervalMs);
      await transactionSql`
        UPDATE runtime_monitoring_schedules
        SET last_scan_id = ${record.id},
            cadence_seconds = ${Math.round(intervalMs / 1_000)},
            next_run_at = ${nextRunAt},
            updated_at = ${scheduledAt}
        WHERE workspace_id = ${record.workspaceId}
      `;
      scheduled.push({
        scanId: record.id,
        workspaceId: record.workspaceId,
        plan: candidate.plan,
        dedupeKey,
      });
    }

    return { candidateCount: candidates.length, deduplicated, scheduled };
  });
}

/**
 * Reserves at most one monitoring Actor run per opted-in business per UTC day.
 * `last_successful_monitor_at` is deliberately read but never changed here;
 * only the successful web executor advances the watermark.
 */
export async function scheduleRedditMonitorScans(
  sql,
  {
    now = new Date(),
    configuration = redditMonitorConfiguration(),
    createRunId = () => `monrun_${randomUUID().replaceAll("-", "")}`,
  } = {},
) {
  const nowMs = validTimestamp(now);
  if (nowMs === null) throw new Error("The Reddit monitoring scheduler timestamp is invalid.");
  const scheduledAt = new Date(nowMs);
  return sql.begin(async (transactionSql) => {
    const monitors = await transactionSql`
      SELECT monitor.workspace_id,
             monitor.seed_scan_id,
             monitor.last_successful_monitor_at,
             monitor.watch_terms
      FROM runtime_reddit_monitors AS monitor
      JOIN runtime_scans AS seed_scan
        ON seed_scan.id = monitor.seed_scan_id
       AND seed_scan.workspace_id = monitor.workspace_id
       AND seed_scan.status = 'complete'
      WHERE monitor.enabled = true
        AND monitor.next_run_at <= ${scheduledAt}
        AND jsonb_array_length(monitor.watch_terms) > 0
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(monitor.watch_terms) AS term
          WHERE COALESCE((term ->> 'active')::boolean, true) = true
            AND length(trim(term ->> 'value')) >= 2
        )
        AND NOT EXISTS (
          SELECT 1
          FROM background_jobs AS pending_job
          WHERE pending_job.type = 'reddit_monitor_scan'
            AND pending_job.payload ->> 'workspaceId' = monitor.workspace_id
            AND pending_job.status IN ('queued', 'running', 'retrying')
        )
      ORDER BY monitor.next_run_at, monitor.workspace_id
      LIMIT 100
      FOR UPDATE OF monitor SKIP LOCKED
    `;
    const scheduled = [];
    for (const monitor of monitors) {
      const activeTerms = Array.isArray(monitor.watch_terms)
        ? monitor.watch_terms
          .filter((term) => term && term.active !== false && typeof term.value === "string")
          .map((term) => term.value.trim())
          .filter(Boolean)
          .slice(0, REDDIT_MONITOR_MAX_WATCH_TERMS)
        : [];
      if (activeTerms.length === 0) continue;
      const runId = createRunId();
      const windowStartedAt = monitor.last_successful_monitor_at
        ? new Date(monitor.last_successful_monitor_at)
        : new Date(nowMs - configuration.firstLookbackHours * 60 * 60 * 1_000);
      const dedupeKey = redditMonitorDedupeKey(monitor.workspace_id, scheduledAt);
      const record = {
        id: runId,
        workspaceId: monitor.workspace_id,
        seedScanId: monitor.seed_scan_id,
        scanId: null,
        status: "queued",
        windowStartedAt: windowStartedAt.toISOString(),
        windowEndedAt: scheduledAt.toISOString(),
        actorRunId: null,
        watchTerms: activeTerms,
        fetched: 0,
        normalized: 0,
        unseen: 0,
        relevant: 0,
        opportunities: 0,
        error: null,
        createdAt: scheduledAt.toISOString(),
        updatedAt: scheduledAt.toISOString(),
      };
      const jobs = await transactionSql`
        INSERT INTO background_jobs (
          type, status, payload, dedupe_key, attempts, max_attempts,
          run_at, created_at, updated_at
        ) VALUES (
          'reddit_monitor_scan',
          'queued',
          ${transactionSql.json({ monitorRunId: runId, workspaceId: monitor.workspace_id })},
          ${dedupeKey},
          0,
          1,
          ${scheduledAt},
          ${scheduledAt},
          ${scheduledAt}
        )
        ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
        RETURNING id
      `;
      if (jobs.length === 0) continue;
      await transactionSql`
        INSERT INTO runtime_reddit_monitor_runs (
          id, workspace_id, seed_scan_id, status, window_started_at,
          window_ended_at, record, created_at, updated_at
        ) VALUES (
          ${runId},
          ${monitor.workspace_id},
          ${monitor.seed_scan_id},
          'queued',
          ${windowStartedAt},
          ${scheduledAt},
          ${transactionSql.json(record)},
          ${scheduledAt},
          ${scheduledAt}
        )
      `;
      scheduled.push({
        runId,
        workspaceId: monitor.workspace_id,
        watchTermCount: activeTerms.length,
        dedupeKey,
      });
    }
    return { candidateCount: monitors.length, scheduled };
  });
}

async function runMonitoringScheduler(sql, signal) {
  const configuration = monitoringConfiguration();
  log("info", "monitor_scheduler_started", {
    pollMs: configuration.schedulerPollMs,
    passIntervalHours: configuration.passIntervalHours,
    coreIntervalMinutes: configuration.coreIntervalMinutes,
  });
  while (!signal.aborted) {
    try {
      const result = await scheduleMonitoringScans(sql, { configuration });
      if (result.scheduled.length > 0 || result.deduplicated > 0) {
        log("info", "monitor_scheduler_poll_completed", {
          candidates: result.candidateCount,
          deduplicated: result.deduplicated,
          scheduled: result.scheduled.length,
          scanIds: result.scheduled.map((entry) => entry.scanId),
        });
      }
    } catch (error) {
      log("error", "monitor_scheduler_poll_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    await waitForNextPoll(signal, configuration.schedulerPollMs);
  }
  log("info", "monitor_scheduler_stopped");
}

async function runRedditMonitorScheduler(sql, signal) {
  const configuration = redditMonitorConfiguration();
  log("info", "reddit_monitor_scheduler_started", { pollMs: configuration.schedulerPollMs });
  while (!signal.aborted) {
    try {
      const result = await scheduleRedditMonitorScans(sql, { configuration });
      if (result.scheduled.length > 0) {
        log("info", "reddit_monitor_scheduler_poll_completed", {
          candidates: result.candidateCount,
          scheduled: result.scheduled.length,
          runs: result.scheduled.map((entry) => ({
            runId: entry.runId,
            watchTermCount: entry.watchTermCount,
          })),
        });
      }
    } catch (error) {
      log("error", "reddit_monitor_scheduler_poll_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    await waitForNextPoll(signal, configuration.schedulerPollMs);
  }
  log("info", "reddit_monitor_scheduler_stopped");
}

/**
 * AI Visibility Tracking (MVP) -- a sidecar to the Reddit monitor above,
 * not built on it: separate tables (runtime_ai_visibility_schedules /
 * runtime_ai_visibility_scans), separate job type (ai_visibility_scan),
 * separate scheduler.
 *
 * This poller itself defaults to on (`AI_VISIBILITY_SCHEDULER_ENABLED`),
 * but every per-workspace schedule row is created with `enabled: false`
 * (see createAiVisibilitySettings in lib/server/ai-visibility-repository.ts)
 * and scheduleAiVisibilityScans below only ever picks up rows where
 * `schedule.enabled = true`. So in practice nothing runs automatically
 * for any workspace until there is a way to flip that flag -- there is no
 * dashboard control for it yet -- rather than tracking a business that
 * never opted in.
 */
export function aiVisibilitySchedulerEnabled(environment = process.env) {
  return String(environment.AI_VISIBILITY_SCHEDULER_ENABLED ?? "true").trim().toLowerCase() !== "false";
}

export function aiVisibilityConfiguration(environment = process.env) {
  return {
    schedulerPollMs: boundedNumber(
      environment.AI_VISIBILITY_SCHEDULER_POLL_MS,
      300_000,
      30_000,
      3_600_000,
    ),
  };
}

/**
 * Reserves at most one AI visibility Actor run per opted-in workspace per
 * poll, for every schedule whose next_run_at (a Monday, see nextMonday in
 * lib/server/ai-visibility-repository.ts) has arrived. The job is inserted
 * first, same ordering as scheduleMonitoringScans, so a dedupe conflict
 * never leaves an orphan scan row.
 */
export async function scheduleAiVisibilityScans(
  sql,
  {
    now = new Date(),
    createScanId = () => `aivis_${randomUUID().replaceAll("-", "")}`,
    maxAttempts = configuredMaxAttempts(),
  } = {},
) {
  const nowMs = validTimestamp(now);
  if (nowMs === null) throw new Error("The AI visibility scheduler timestamp is invalid.");
  const scheduledAt = new Date(nowMs);

  return sql.begin(async (transactionSql) => {
    const schedules = await transactionSql`
      SELECT schedule.workspace_id, schedule.seed_scan_id
      FROM runtime_ai_visibility_schedules AS schedule
      JOIN runtime_scans AS seed_scan
        ON seed_scan.id = schedule.seed_scan_id
       AND seed_scan.workspace_id = schedule.workspace_id
       AND seed_scan.status = 'complete'
      WHERE schedule.enabled = true
        AND schedule.next_run_at <= ${scheduledAt}
        AND NOT EXISTS (
          SELECT 1
          FROM background_jobs AS pending_job
          WHERE pending_job.type = 'ai_visibility_scan'
            AND pending_job.payload ->> 'workspaceId' = schedule.workspace_id
            AND pending_job.status IN ('queued', 'running', 'retrying')
        )
      ORDER BY schedule.next_run_at, schedule.workspace_id
      LIMIT 100
      FOR UPDATE OF schedule SKIP LOCKED
    `;

    const scheduled = [];
    for (const row of schedules) {
      const scanId = createScanId();
      const dedupeKey = `ai-visibility-run:${scanId}`;
      const record = {
        id: scanId,
        workspaceId: row.workspace_id,
        seedScanId: row.seed_scan_id,
        status: "queued",
        questions: [],
        answers: [],
        metrics: null,
        error: null,
        createdAt: scheduledAt.toISOString(),
        updatedAt: scheduledAt.toISOString(),
      };
      const jobs = await transactionSql`
        INSERT INTO background_jobs (
          type, status, payload, dedupe_key, attempts, max_attempts,
          run_at, created_at, updated_at
        ) VALUES (
          'ai_visibility_scan',
          'queued',
          ${transactionSql.json({ visibilityScanId: scanId, workspaceId: row.workspace_id })},
          ${dedupeKey},
          0,
          ${maxAttempts},
          ${scheduledAt},
          ${scheduledAt},
          ${scheduledAt}
        )
        ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
        RETURNING id
      `;
      if (jobs.length === 0) continue;
      await transactionSql`
        INSERT INTO runtime_ai_visibility_scans (
          id, workspace_id, seed_scan_id, status, questions, answers, metrics,
          error, created_at, updated_at
        ) VALUES (
          ${record.id},
          ${record.workspaceId},
          ${record.seedScanId},
          'queued',
          ${transactionSql.json(record.questions)},
          ${transactionSql.json(record.answers)},
          NULL,
          NULL,
          ${scheduledAt},
          ${scheduledAt}
        )
      `;
      scheduled.push({ scanId: record.id, workspaceId: record.workspaceId, dedupeKey });
    }
    return { candidateCount: schedules.length, scheduled };
  });
}

async function runAiVisibilityScheduler(sql, signal) {
  const configuration = aiVisibilityConfiguration();
  log("info", "ai_visibility_scheduler_started", { pollMs: configuration.schedulerPollMs });
  while (!signal.aborted) {
    try {
      const result = await scheduleAiVisibilityScans(sql);
      if (result.scheduled.length > 0) {
        log("info", "ai_visibility_scheduler_poll_completed", {
          candidates: result.candidateCount,
          scheduled: result.scheduled.length,
        });
      }
    } catch (error) {
      log("error", "ai_visibility_scheduler_poll_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    await waitForNextPoll(signal, configuration.schedulerPollMs);
  }
  log("info", "ai_visibility_scheduler_stopped");
}

export function jobExecutionConfiguration(environment = process.env) {
  const timeoutSeconds = boundedNumber(
    environment.BACKGROUND_JOB_TIMEOUT_SECONDS,
    1_200,
    1_200,
    1_800,
  );
  const heartbeatSeconds = boundedNumber(
    environment.BACKGROUND_JOB_HEARTBEAT_SECONDS,
    15,
    5,
    60,
  );
  const configuredStaleSeconds = boundedNumber(
    environment.BACKGROUND_JOB_LEASE_STALE_SECONDS,
    90,
    45,
    300,
  );
  return {
    timeoutSeconds,
    heartbeatSeconds,
    staleSeconds: Math.max(configuredStaleSeconds, heartbeatSeconds * 3),
  };
}

export async function refreshJobLease(sql, jobId, workerIdValue) {
  const rows = await sql`
    UPDATE background_jobs
    SET locked_at = now(), updated_at = now()
    WHERE id = ${jobId}
      AND status = 'running'
      AND locked_by = ${workerIdValue}
    RETURNING id
  `;
  return rows.length > 0;
}

export async function maintainJobLease(sql, job, workerIdValue, signal, heartbeatMs) {
  while (!signal.aborted) {
    await waitForNextPoll(signal, heartbeatMs);
    if (signal.aborted) return;
    try {
      const refreshed = await refreshJobLease(sql, job.id, workerIdValue);
      if (!refreshed) {
        log("warn", "job_lease_lost", { jobId: job.id });
        return;
      }
    } catch (error) {
      log("warn", "job_lease_refresh_failed", {
        jobId: job.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export async function claimJob(sql, workerIdValue) {
  const { staleSeconds: boundedStaleSeconds } = jobExecutionConfiguration();
  const staleBefore = new Date(Date.now() - boundedStaleSeconds * 1_000);
  const rows = await sql`
    WITH candidate AS (
      SELECT id
      FROM background_jobs
      WHERE (
        (status IN ('queued', 'retrying') AND run_at <= now())
        OR (status = 'running' AND locked_at <= ${staleBefore})
      )
      AND type IN ('scan.run', 'reddit_monitor_scan', 'ai_visibility_scan')
      AND attempts < max_attempts
      ORDER BY run_at ASC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE background_jobs AS job
    SET status = 'running',
        attempts = job.attempts + 1,
        locked_at = now(),
        locked_by = ${workerIdValue},
        updated_at = now()
    FROM candidate
    WHERE job.id = candidate.id
    RETURNING job.*
  `;
  return rows[0] ?? null;
}

async function completeJob(sql, job) {
  await sql`
    UPDATE background_jobs
    SET status = 'succeeded',
        locked_at = NULL,
        locked_by = NULL,
        last_error = NULL,
        finished_at = now(),
        updated_at = now()
    WHERE id = ${job.id} AND locked_by = ${workerId}
  `;
}

const TERMINAL_SCAN_ERROR_CODES = new Set([
  "reddit_enrichment_failed",
  "openai_structured_output_failed",
  "scan_execution_timeout",
]);

function executorErrorCode(responseText) {
  try {
    const payload = JSON.parse(responseText);
    const code = payload?.error?.code;
    return typeof code === "string" && code.trim() ? code.trim() : null;
  } catch {
    return null;
  }
}

export class WorkerExecutorHttpError extends Error {
  constructor(status, responseText) {
    super(`Web executor returned HTTP ${status}: ${responseText.slice(0, 1_000)}`);
    this.name = "WorkerExecutorHttpError";
    this.status = status;
    this.code = executorErrorCode(responseText);
  }
}

export class WorkerExecutorTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Web executor timed out after ${timeoutMs}ms.`);
    this.name = "WorkerExecutorTimeoutError";
    this.code = "scan_execution_timeout";
  }
}

export function assertSuccessfulExecutorPayload(payload) {
  if (payload?.ok === false && payload?.error) {
    const status = Number(payload.executorStatus);
    throw new WorkerExecutorHttpError(
      Number.isInteger(status) && status >= 400 ? status : 500,
      JSON.stringify({ error: payload.error }),
    );
  }
  return payload;
}

export async function waitForScanExecution(options) {
  const startedAt = Date.now();
  const pollMs = Math.max(250, Math.min(Number(options.pollMs ?? 2_000), 30_000));
  while (!options.signal.aborted) {
    if (Date.now() - startedAt >= options.timeoutMs) {
      throw new WorkerExecutorTimeoutError(options.timeoutMs);
    }
    const payload = assertSuccessfulExecutorPayload(await options.poll());
    if (payload?.complete === true || payload?.status === "complete") return payload;
    await waitForNextPoll(options.signal, pollMs);
  }
  throw options.signal.reason instanceof Error
    ? options.signal.reason
    : new Error("Background scan execution was interrupted.");
}

export function isRetryableJobError(error) {
  return !(
    error &&
    typeof error === "object" &&
    typeof error.code === "string" &&
    TERMINAL_SCAN_ERROR_CODES.has(error.code)
  );
}

export function jobFailureDisposition(job, error, now = new Date()) {
  const exhausted = job.attempts >= job.max_attempts;
  const retryable = isRetryableJobError(error);
  const terminal = exhausted || !retryable;
  const delaySeconds = Math.min(300, 2 ** job.attempts * 5);
  const retryAt = new Date(now.getTime() + delaySeconds * 1_000);
  return {
    status: terminal ? "failed" : "retrying",
    retryable,
    terminal,
    exhausted,
    retryAt,
    finishedAt: terminal ? now : null,
  };
}

async function failJob(sql, job, error, disposition = jobFailureDisposition(job, error)) {
  const message = error instanceof Error ? error.message : String(error);
  await sql`
    UPDATE background_jobs
    SET status = ${disposition.status}::job_status,
        run_at = ${disposition.retryAt},
        locked_at = NULL,
        locked_by = NULL,
        last_error = ${message.slice(0, 4_000)},
        finished_at = ${disposition.finishedAt},
        updated_at = now()
    WHERE id = ${job.id} AND locked_by = ${workerId}
  `;
}

/**
 * Node's built-in fetch is backed by Undici and can end a long request around
 * its header timeout even when our AbortSignal allows a longer job. Scan jobs
 * deliberately use the core HTTP client so BACKGROUND_JOB_TIMEOUT_SECONDS is
 * the single execution timeout we control.
 */
export function postJsonWithLongTimeout(urlValue, options) {
  const url = new URL(urlValue);
  const requestFn = url.protocol === "https:" ? httpsRequest : url.protocol === "http:" ? httpRequest : null;
  if (!requestFn) return Promise.reject(new Error("Worker executor URL must use HTTP or HTTPS."));
  const body = JSON.stringify(options.body ?? {});
  const maxResponseBytes = options.maxResponseBytes ?? 1_000_000;

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    const request = requestFn(url, {
      method: "POST",
      headers: {
        ...options.headers,
        "content-length": Buffer.byteLength(body),
      },
      signal: options.signal,
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxResponseBytes) {
          response.destroy(new Error("Web executor response exceeded the size limit."));
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", finishReject);
      response.once("end", () => {
        if (settled) return;
        const text = Buffer.concat(chunks).toString("utf8");
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          finishReject(new WorkerExecutorHttpError(status, text));
          return;
        }
        let payload;
        try {
          payload = text ? JSON.parse(text) : {};
        } catch {
          finishReject(new Error("Web executor returned invalid JSON."));
          return;
        }
        settled = true;
        resolvePromise(payload);
      });
    });
    request.once("error", finishReject);
    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new WorkerExecutorTimeoutError(options.timeoutMs));
    });
    request.end(body);
  });
}

export async function executeScanJob(job, signal) {
  const workerSecret = requiredEnvironment("BACKGROUND_WORKER_SECRET");
  if (workerSecret.length < 32) {
    throw new Error("BACKGROUND_WORKER_SECRET must contain at least 32 characters.");
  }
  const { timeoutSeconds: boundedTimeoutSeconds } = jobExecutionConfiguration();
  const timeoutMs = boundedTimeoutSeconds * 1_000;
  const timeout = AbortSignal.timeout(timeoutMs);
  const combinedSignal = AbortSignal.any([signal, timeout]);
  const executeUrl = `${internalWorkerUrl()}/api/internal/jobs/${encodeURIComponent(job.id)}/execute`;
  const headers = {
    authorization: `Bearer ${workerSecret}`,
    "content-type": "application/json",
    accept: "application/json",
  };
  try {
    const started = assertSuccessfulExecutorPayload(await postJsonWithLongTimeout(
      executeUrl,
      {
        headers,
        body: { workerId },
        signal: combinedSignal,
        timeoutMs: 30_000,
        maxResponseBytes: 1_000_000,
      },
    ));
    if (started?.complete === true || started?.status === "complete") return started;
    return await waitForScanExecution({
      signal: combinedSignal,
      timeoutMs,
      pollMs: Number(process.env.BACKGROUND_JOB_STATUS_POLL_MS ?? 2_000),
      poll: () => postJsonWithLongTimeout(
        executeUrl,
        {
          headers,
          body: { workerId },
          signal: combinedSignal,
          timeoutMs: 30_000,
          maxResponseBytes: 1_000_000,
        },
      ),
    });
  } catch (error) {
    if (timeout.aborted && !signal.aborted) {
      throw new WorkerExecutorTimeoutError(boundedTimeoutSeconds * 1_000);
    }
    throw error;
  }
}

async function runQueueWorker(databaseUrl, signal) {
  const sql = postgres(databaseUrl, {
    max: 2,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });
  const pollMs = Number(process.env.BACKGROUND_JOB_POLL_MS ?? 2_000);
  const boundedPollMs = Number.isFinite(pollMs) ? Math.max(250, Math.min(pollMs, 30_000)) : 2_000;
  const queueController = new AbortController();
  const queueSignal = AbortSignal.any([signal, queueController.signal]);
  const scheduler = monitoringSchedulerEnabled()
    ? runMonitoringScheduler(sql, queueSignal)
    : Promise.resolve();
  const redditMonitorScheduler = redditMonitorSchedulerEnabled()
    ? runRedditMonitorScheduler(sql, queueSignal)
    : Promise.resolve();
  const aiVisibilityScheduler = aiVisibilitySchedulerEnabled()
    ? runAiVisibilityScheduler(sql, queueSignal)
    : Promise.resolve();
  if (!monitoringSchedulerEnabled()) {
    log("info", "monitor_scheduler_disabled", { reason: "single_on_demand_scan_mvp" });
  }
  if (!redditMonitorSchedulerEnabled()) {
    log("info", "reddit_monitor_scheduler_disabled");
  }
  if (!aiVisibilitySchedulerEnabled()) {
    log("info", "ai_visibility_scheduler_disabled");
  }
  log("info", "queue_worker_started", { pollMs: boundedPollMs });
  try {
    while (!queueSignal.aborted) {
      const job = await claimJob(sql, workerId);
      if (!job) {
        await waitForNextPoll(queueSignal, boundedPollMs);
        continue;
      }
      log("info", "job_claimed", {
      jobId: job.id,
      type: job.type,
      attempt: job.attempts,
      maxAttempts: job.max_attempts,
    });
    const leaseController = new AbortController();
    const leaseSignal = AbortSignal.any([queueSignal, leaseController.signal]);
    const { heartbeatSeconds } = jobExecutionConfiguration();
    const leaseTask = maintainJobLease(sql, job, workerId, leaseSignal, heartbeatSeconds * 1_000);
    try {
      const result = await executeScanJob(job, queueSignal);
      await completeJob(sql, job);
      log("info", "job_succeeded", { jobId: job.id, scanId: result.scanId });
    } catch (error) {
      const disposition = jobFailureDisposition(job, error);
      await failJob(sql, job, error, disposition);
      log("error", "job_failed", {
        jobId: job.id,
        attempt: job.attempts,
        retryable: disposition.retryable,
        terminal: disposition.terminal,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      leaseController.abort("job finished");
      await leaseTask;
    }
    }
  } finally {
    queueController.abort("queue worker stopping");
    await Promise.all([scheduler, redditMonitorScheduler, aiVisibilityScheduler]);
    await sql.end({ timeout: 5 });
    log("info", "queue_worker_stopped");
  }
}

async function runWorker() {
  const databaseUrl = requiredEnvironment("DATABASE_URL");
  await verifyDatabase(databaseUrl);

  const mode = process.env.BACKGROUND_WORKER_MODE?.trim().toLowerCase() || "queue";
  const shutdown = createShutdownController();

  if (mode === "standby") {
    if (process.env.BACKGROUND_WORKER_ALLOW_STANDBY !== "true") {
      throw new Error(
        "Standby mode requires BACKGROUND_WORKER_ALLOW_STANDBY=true so a no-op worker is never enabled accidentally.",
      );
    }
    log("warn", "standby_not_processing_jobs", {
      message:
        "PostgreSQL is reachable, but no persistent job handler is configured. Replace the demo in-memory store before production launch.",
    });
    await waitInStandby(shutdown.signal);
    log("info", "standby_stopped");
    return;
  }

  if (mode === "queue") {
    await runQueueWorker(databaseUrl, shutdown.signal);
    return;
  }
  if (mode !== "module") {
    throw new Error("BACKGROUND_WORKER_MODE must be `queue`, `module`, or `standby`.");
  }
  await runModuleWorker(shutdown.signal);
}

async function main() {
  const command = process.argv[2] ?? "work";
  if (command === "migrate") {
    await runMigrations();
    return;
  }
  if (command === "work") {
    await runWorker();
    return;
  }
  throw new Error("Usage: node scripts/background-worker.mjs <work|migrate>");
}

const entrypointUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (entrypointUrl === import.meta.url) {
  main().catch((error) => {
    log("error", "fatal", {
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}
