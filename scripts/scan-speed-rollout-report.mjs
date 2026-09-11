#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const REQUIRED = ["from", "to", "baseline-config", "candidate-config"];

export function parseReportArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const [rawName, inline] = argument.slice(2).split("=", 2);
    const value = inline ?? argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`--${rawName} requires a value.`);
    values[rawName] = value;
  }
  for (const name of REQUIRED) if (!values[name]) throw new Error(`--${name} is required.`);
  const from = new Date(values.from), to = new Date(values.to);
  if (!Number.isFinite(from.valueOf()) || !Number.isFinite(to.valueOf()) || from >= to) {
    throw new Error("--from and --to must be valid ISO timestamps with from earlier than to.");
  }
  if (values["baseline-config"] === values["candidate-config"]) {
    throw new Error("Baseline and candidate configuration IDs must differ.");
  }
  const minimumSample = values["minimum-sample"] === undefined ? 30 : Number(values["minimum-sample"]);
  if (!Number.isInteger(minimumSample) || minimumSample < 1 || minimumSample > 10_000) {
    throw new Error("--minimum-sample must be an integer from 1 to 10000.");
  }
  return { from: from.toISOString(), to: to.toISOString(), baselineConfig: values["baseline-config"],
    candidateConfig: values["candidate-config"], minimumSample, label: values.label ?? "unspecified_environment" };
}

function timestamp(value) {
  if (!value) return null;
  const parsed = new Date(value).valueOf();
  return Number.isFinite(parsed) ? parsed : null;
}

export function durationMs(start, end) {
  const first = timestamp(start), last = timestamp(end);
  return first === null || last === null || last < first ? null : last - first;
}

export function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function distribution(values, digits = 0) {
  const valid = values.filter(value => value !== null && value !== undefined && value !== "").map(Number).filter(Number.isFinite);
  const rounded = value => value === null ? null : Number(value.toFixed(digits));
  return { observations: valid.length, p50: rounded(percentile(valid, 0.5)), p90: rounded(percentile(valid, 0.9)),
    p95: rounded(percentile(valid, 0.95)), mean: valid.length ? rounded(valid.reduce((sum, value) => sum + value, 0) / valid.length) : null };
}

function rate(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(4)) : null;
}

export function summarizeRolloutRows(rows, { minimumSample = 30 } = {}) {
  const complete = rows.filter(row => row.status === "complete");
  const failed = rows.filter(row => row.status === "failed");
  const terminalRows = rows.filter(row => row.status === "complete" || row.status === "failed");
  const fullDurations = terminalRows.map(row => durationMs(row.run_accepted_at, row.finished_at)).filter(value => value !== null);
  const processingDurations = terminalRows.map(row => durationMs(row.run_started_at, row.finished_at)).filter(value => value !== null);
  const queueDurations = terminalRows.map(row => durationMs(row.run_accepted_at, row.run_started_at)).filter(value => value !== null);
  const analysisDurations = terminalRows.map(row => durationMs(row.analysis_accepted_at, row.analysis_finished_at)).filter(value => value !== null);
  const firstResultDurations = terminalRows.map(row => durationMs(row.run_accepted_at, row.first_result_at)).filter(value => value !== null);
  const firstPreviewDurations = terminalRows.map(row => durationMs(row.run_accepted_at, row.first_preview_at)).filter(value => value !== null);
  const firstQualifiedDurations = terminalRows.map(row => durationMs(row.run_accepted_at, row.first_qualified_at)).filter(value => value !== null);
  const countTrue = name => terminalRows.filter(row => row[name] === true).length;
  const attempts = terminalRows.map(row => row.job_attempts).filter(value => value !== null && value !== undefined && value !== "")
    .map(Number).filter(Number.isFinite);
  const costs = terminalRows.map(row => row.estimated_cost_usd).filter(value => value !== null && value !== undefined && value !== "")
    .map(Number).filter(Number.isFinite);
  const full = distribution(fullDurations);
  const providerBacked = terminalRows.length > 0
    && terminalRows.every(row => row.reddit_provider && row.reddit_provider !== "mock" && row.ai_enabled === true);
  const eligible = terminalRows.length >= minimumSample && full.observations >= minimumSample && providerBacked;
  const counts = name => Object.fromEntries([...new Set(terminalRows.map(row => row[name] ?? "unknown"))].sort()
    .map(value => [value, terminalRows.filter(row => (row[name] ?? "unknown") === value).length]));
  return {
    observedRows: rows.length,
    sampleSize: terminalRows.length,
    evidenceModes: { providerBacked, redditProvider: counts("reddit_provider"), data: counts("data_mode"), analysis: counts("analysis_mode") },
    terminal: { complete: complete.length, failed: failed.length, nonterminalExcluded: rows.length - terminalRows.length,
      completionRate: rate(complete.length, terminalRows.length) },
    latencyMs: {
      fullFromRunAcceptance: full,
      processingWorkerStartToFinal: distribution(processingDurations),
      queueWait: distribution(queueDurations),
      analysisAcceptanceToReviewReady: distribution(analysisDurations),
      firstResultFromRunAcceptance: distribution(firstResultDurations),
      firstPreviewFromRunAcceptance: distribution(firstPreviewDurations),
      firstQualifiedFromRunAcceptance: distribution(firstQualifiedDurations),
    },
    quality: {
      coverageComplete: countTrue("coverage_complete"), coverageCompleteRate: rate(countTrue("coverage_complete"), terminalRows.length),
      discoveryComplete: countTrue("discovery_complete"), triageComplete: countTrue("triage_complete"),
      unresolvedTriage: distribution(terminalRows.map(row => row.triage_unresolved)),
      deepReviewTarget: distribution(terminalRows.map(row => row.deep_review_target)),
      deepReviewCompleted: distribution(terminalRows.map(row => row.deep_review_completed)),
      fetchedCandidates: distribution(terminalRows.map(row => row.fetched_candidates)),
    },
    output: {
      qualifiedPeople: distribution(terminalRows.map(row => row.qualified_people)),
      relevantConversations: distribution(terminalRows.map(row => row.relevant_conversations)),
      repliesReady: distribution(terminalRows.map(row => row.replies_ready)),
    },
    retries: { attempts: distribution(attempts), scansWithRetry: attempts.filter(value => value > 1).length,
      retryRate: rate(attempts.filter(value => value > 1).length, attempts.length) },
    estimatedCostUsd: { knownObservations: costs.length,
      totalKnown: Number(costs.reduce((sum, value) => sum + value, 0).toFixed(6)), perScan: distribution(costs, 6) },
    etaPublication: eligible
      ? { eligible: true, basis: "same-configuration run-acceptance-to-final observations", sampleSize: full.observations,
        p50Ms: full.p50, p90Ms: full.p90 }
      : { eligible: false, reason: !providerBacked ? "ETA evidence must come entirely from provider-backed scans."
        : `Need at least ${minimumSample} same-configuration completed latency observations; found ${full.observations}.`,
        sampleSize: full.observations },
  };
}

const query = async (sql, options) => sql`
  SELECT
    scan.status,
    scan.record #>> '{runConfiguration,id}' AS config_id,
    scan.record #>> '{runtimeProgress,acceptedAt}' AS analysis_accepted_at,
    scan.record #>> '{runtimeProgress,analysisFinishedAt}' AS analysis_finished_at,
    scan.record #>> '{runConfiguration,environment,REDDIT_PROVIDER}' AS reddit_provider,
    (scan.record #>> '{runConfiguration,aiEnabled}')::boolean AS ai_enabled,
    scan.record #>> '{result,dataMode}' AS data_mode,
    scan.record #>> '{result,analysisMode}' AS analysis_mode,
    scan.record #>> '{durableJob,acceptedAt}' AS run_accepted_at,
    scan.record #>> '{runtimeProgress,runStartedAt}' AS run_started_at,
    COALESCE(scan.record #>> '{runtimeProgress,finishedAt}', scan.record #>> '{timing,finishedAt}') AS finished_at,
    scan.record #>> '{timing,firstResultAt}' AS first_result_at,
    scan.record #>> '{timing,firstPreviewAt}' AS first_preview_at,
    scan.record #>> '{timing,firstQualifiedAt}' AS first_qualified_at,
    (scan.record #>> '{runtimeProgress,coverageComplete}')::boolean AS coverage_complete,
    (scan.record #>> '{runtimeProgress,discoveryComplete}')::boolean AS discovery_complete,
    (scan.record #>> '{runtimeProgress,triageComplete}')::boolean AS triage_complete,
    (scan.record #>> '{runtimeProgress,triage,unresolved}')::integer AS triage_unresolved,
    (scan.record #>> '{runtimeProgress,deepReview,target}')::integer AS deep_review_target,
    (scan.record #>> '{runtimeProgress,deepReview,completed}')::integer AS deep_review_completed,
    (scan.record #>> '{runtimeProgress,fetched}')::integer AS fetched_candidates,
    (scan.record #>> '{runtimeProgress,results,qualifiedPeople}')::integer AS qualified_people,
    (scan.record #>> '{runtimeProgress,results,relevantConversations}')::integer AS relevant_conversations,
    (scan.record #>> '{runtimeProgress,results,repliesReady}')::integer AS replies_ready,
    latest_job.attempts AS job_attempts,
    CASE WHEN jsonb_typeof(scan.record #> '{result,usage}') = 'array' THEN
      COALESCE((SELECT SUM((usage_row ->> 'estimatedCostUsd')::numeric)
        FROM jsonb_array_elements(scan.record #> '{result,usage}') AS usage_row), 0)
      ELSE NULL END AS estimated_cost_usd
  FROM runtime_scans AS scan
  LEFT JOIN LATERAL (
    SELECT job.attempts
    FROM background_jobs AS job
    WHERE job.type = 'scan.run' AND job.payload ->> 'scanId' = scan.id
    ORDER BY job.created_at DESC
    LIMIT 1
  ) AS latest_job ON true
  WHERE scan.record #>> '{durableJob,type}' = 'scan.run'
    AND (scan.record #>> '{durableJob,acceptedAt}')::timestamptz >= ${options.from}::timestamptz
    AND (scan.record #>> '{durableJob,acceptedAt}')::timestamptz < ${options.to}::timestamptz
    AND COALESCE(scan.record ->> 'scanKind', 'discovery') = 'discovery'
    AND scan.record #>> '{runConfiguration,id}' IN (${options.baselineConfig}, ${options.candidateConfig})
  ORDER BY scan.created_at
`;

export async function runReport(options, databaseUrl = process.env.DEMANDSIFT_REPORT_DATABASE_URL, connection) {
  if (!databaseUrl) throw new Error("DEMANDSIFT_REPORT_DATABASE_URL is required; DATABASE_URL is intentionally ignored.");
  let parsed;
  try { parsed = new URL(databaseUrl); } catch { throw new Error("DEMANDSIFT_REPORT_DATABASE_URL must be a PostgreSQL URL."); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("DEMANDSIFT_REPORT_DATABASE_URL must be a PostgreSQL URL.");
  const sql = postgres(databaseUrl, { max: 1, prepare: false, application_name: "demandsift_scan_speed_read_only_report",
    ...(connection ? { connection } : {}) });
  try {
    const rows = await sql.begin(async transaction => {
      await transaction`SET TRANSACTION READ ONLY`;
      return query(transaction, options);
    });
    const byConfig = configId => summarizeRolloutRows(rows.filter(row => row.config_id === configId), options);
    const providerBacked = rows.length > 0 && rows.every(row => row.reddit_provider && row.reddit_provider !== "mock" && row.ai_enabled === true);
    return { kind: "database_observations", label: options.label, providerBacked, window: { from: options.from, to: options.to },
      reviewDwellIncluded: false, minimumSample: options.minimumSample,
      baseline: { configId: options.baselineConfig, ...byConfig(options.baselineConfig) },
      candidate: { configId: options.candidateConfig, ...byConfig(options.candidateConfig) } };
  } finally {
    await sql.end({ timeout: 2 });
  }
}

async function main() {
  try {
    const options = parseReportArguments(process.argv.slice(2));
    const report = await runReport(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Could not generate scan-speed report."}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
