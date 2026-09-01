import { createHash } from "node:crypto";
import { deepQualificationBudget, ScanDepthConfigurationError, validateThreadFetchConfiguration } from "./scan-depth";
import { aiCapacityFromEnv } from "../ai/capacity";

// Closed allowlist: credentials, prompts, queries, account IDs, and URLs are
// never persisted here. Null explicitly means absent, not "read today's env".
const CONFIG_KEYS = [
  "REDDIT_PROVIDER", "REDDIT_TRIAGE_BUDGET", "REDDIT_EMBEDDING_PREFILTER_FLOOR",
  "REDDIT_ACQUISITION_CANDIDATES", "REDDIT_ENRICHMENT_BUDGET", "REDDIT_MINIMUM_FULL_CONTEXT_REVIEWS",
  "REDDIT_DEEP_QUALIFICATION_BUDGET",
  "SCAN_OVERLAP_DISCOVERY_TRIAGE", "SCAN_EARLY_TRIAGE_LIMIT", "SCAN_EARLY_TRIAGE_FLUSH_MS",
  "SCAN_COORDINATED_RETRIES", "AI_RECOVERY_MAX_REQUESTS", "AI_RECOVERY_DEADLINE_MS",
  "SCAN_COMPACT_TRIAGE",
  "SCAN_PARTIAL_RESULTS",
  "AI_TRIAGE_BATCH_SIZE", "AI_REQUEST_CONCURRENCY",
  "APIFY_REDDIT_TEST_MODE", "APIFY_REDDIT_ACTOR_ID", "APIFY_REDDIT_MAX_RESULTS",
  "APIFY_REDDIT_ENRICHMENT_LIMIT", "APIFY_REDDIT_ENRICHMENT_COMMENTS", "APIFY_REDDIT_TIMEOUT_MS", "APIFY_REDDIT_TIME_RANGE",
  "HARSHMAUR_REDDIT_ACTOR_ID", "HARSHMAUR_REDDIT_MAX_RESULTS", "HARSHMAUR_REDDIT_MAX_TERMS",
  "HARSHMAUR_REDDIT_MAX_QUERIES", "HARSHMAUR_REDDIT_DISCOVERY_MODE", "HARSHMAUR_REDDIT_QUERIES_PER_RUN",
  "HARSHMAUR_REDDIT_POSTS_PER_QUERY", "HARSHMAUR_REDDIT_MAX_CONCURRENT_RUNS",
  "OPENAI_ANALYSIS_MODEL", "OPENAI_ECONOMY_MODEL", "OPENAI_EMBEDDING_MODEL", "OPENAI_API_STYLE",
  "OPENAI_TIMEOUT_MS", "OPENAI_MAX_RETRIES", "OPENAI_ANALYSIS_FALLBACK_MODELS", "OPENAI_ECONOMY_FALLBACK_MODELS",
] as const;
const ROUTE_KEYS = ["OPENAI_BASE_URL", "OPENAI_DIRECT_FALLBACK_BASE_URL", "REDDIT_API_BASE_URL"] as const;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export type ScanRunConfiguration = {
  version: 1; id: string; resolvedAt: string; defaultsVersion: "deployed-cb24c44-v1" | "quality-depth-v2";
  migratedFromId?: string;
  environment: Record<string, string | null>;
  routeFingerprints: Record<string, string>;
  aiEnabled: boolean; directFallbackEnabled: boolean;
  // Reserved behavior flags stay false until their individual acceptance gates.
  flags: { overlapDiscoveryTriage: boolean; compactTriage: boolean; partialResults: boolean };
  rollout?: {
    workspaceBucket: number | null;
    internalWorkspace: boolean;
    percentages: Record<"coordinatedRetries" | "overlapDiscoveryTriage" | "compactTriage" | "partialResults", number>;
  };
  effective?: {
    workflow: Record<string, number>;
    models: { analysisModel: string; economyModel: string; embeddingModel: string };
    ai?: ReturnType<import("../providers/openai.server").OpenAiProvider["configurationForDiagnostics"]>;
    reddit?: Record<string, string | number | boolean>;
  };
};

const ROLLOUTS = {
  coordinatedRetries: ["SCAN_COORDINATED_RETRIES", "SCAN_COORDINATED_RETRIES_ROLLOUT_PERCENT"],
  overlapDiscoveryTriage: ["SCAN_OVERLAP_DISCOVERY_TRIAGE", "SCAN_OVERLAP_DISCOVERY_TRIAGE_ROLLOUT_PERCENT"],
  compactTriage: ["SCAN_COMPACT_TRIAGE", "SCAN_COMPACT_TRIAGE_ROLLOUT_PERCENT"],
  partialResults: ["SCAN_PARTIAL_RESULTS", "SCAN_PARTIAL_RESULTS_ROLLOUT_PERCENT"],
} as const;
type RolloutFlag = keyof typeof ROLLOUTS;
type RolloutPercentages = Record<RolloutFlag, number>;

function rolloutPercent(value: string | undefined, name: string) {
  if (value === undefined || value.trim() === "") return 100;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new ScanDepthConfigurationError(`${name} must be an integer from 0 to 100.`);
  }
  return parsed;
}

function workspaceRollout(env: NodeJS.ProcessEnv, workspaceId?: string) {
  const internal = new Set((env.SCAN_SPEED_INTERNAL_WORKSPACES ?? "").split(",").map(value => value.trim()).filter(Boolean));
  const internalWorkspace = Boolean(workspaceId && internal.has(workspaceId));
  const workspaceBucket = workspaceId
    ? Number.parseInt(hash(`scan-speed-rollout:${workspaceId}`).slice(0, 8), 16) % 100
    : null;
  const percentages = Object.fromEntries(Object.entries(ROLLOUTS).map(([name, [, percentKey]]) =>
    [name, rolloutPercent(env[percentKey], percentKey)])) as RolloutPercentages;
  const enabled = Object.fromEntries(Object.entries(ROLLOUTS).map(([name, [flagKey]]) => [name,
    env[flagKey] === "1" && (internalWorkspace || (workspaceBucket !== null && workspaceBucket < percentages[name as RolloutFlag])
      || (workspaceBucket === null && percentages[name as RolloutFlag] === 100)),
  ])) as Record<RolloutFlag, boolean>;
  return { workspaceBucket, internalWorkspace, percentages, enabled };
}

export function resolveScanConfiguration(env: NodeJS.ProcessEnv = process.env, context: { workspaceId?: string } = {}): ScanRunConfiguration {
  const rollout = workspaceRollout(env, context.workspaceId);
  const environment = Object.fromEntries(CONFIG_KEYS.map(key => [key, env[key] ?? null]));
  // Keep the workflow's existing default (including when APP_RUNTIME_ENV is production).
  environment.REDDIT_PROVIDER = env.REDDIT_PROVIDER?.trim() || "mock";
  environment.REDDIT_DEEP_QUALIFICATION_BUDGET = String(deepQualificationBudget(env));
  const aiCapacity = aiCapacityFromEnv(env);
  environment.AI_TRIAGE_BATCH_SIZE = String(aiCapacity.triageBatchSize);
  environment.AI_REQUEST_CONCURRENCY = String(aiCapacity.requestConcurrency);
  // Persist the resolved behavior, not the mutable rollout knobs. A retry
  // therefore remains in its accepted cohort even after 5% becomes 25%.
  environment.SCAN_COORDINATED_RETRIES = rollout.enabled.coordinatedRetries ? "1" : null;
  environment.SCAN_OVERLAP_DISCOVERY_TRIAGE = rollout.enabled.overlapDiscoveryTriage ? "1" : null;
  environment.SCAN_COMPACT_TRIAGE = rollout.enabled.compactTriage ? "1" : null;
  environment.SCAN_PARTIAL_RESULTS = rollout.enabled.partialResults ? "1" : null;
  const value = { version: 1 as const, defaultsVersion: "quality-depth-v2" as const, environment,
    routeFingerprints: Object.fromEntries(ROUTE_KEYS.map(key => [key, hash(env[key] ?? null)])),
    aiEnabled: Boolean(env.OPENAI_API_KEY?.trim()), directFallbackEnabled: Boolean(env.OPENAI_DIRECT_FALLBACK_API_KEY?.trim()),
    flags: { overlapDiscoveryTriage: rollout.enabled.overlapDiscoveryTriage, compactTriage: rollout.enabled.compactTriage,
      partialResults: rollout.enabled.partialResults },
    rollout: { workspaceBucket: rollout.workspaceBucket, internalWorkspace: rollout.internalWorkspace,
      percentages: rollout.percentages },
  };
  return { ...value, id: hash(value), resolvedAt: new Date().toISOString() };
}

/** Explicit quality correction for T01 receipts; never re-read today's knobs. */
export function upgradeScanDepthConfiguration(config: ScanRunConfiguration): ScanRunConfiguration {
  if (config.defaultsVersion === "quality-depth-v2") return config;
  const savedEnv = Object.fromEntries(Object.entries(config.environment).filter((entry): entry is [string, string] => entry[1] !== null));
  const upgraded: ScanRunConfiguration = { ...config, defaultsVersion: "quality-depth-v2", migratedFromId: config.id,
    environment: { ...config.environment, REDDIT_DEEP_QUALIFICATION_BUDGET: String(deepQualificationBudget(savedEnv)) } };
  delete upgraded.effective;
  const identity = { ...upgraded } as Partial<ScanRunConfiguration>;
  delete identity.id;
  delete identity.resolvedAt;
  upgraded.id = hash(identity);
  return upgraded;
}

export function environmentForScan(config: ScanRunConfiguration, current: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...current };
  for (const key of CONFIG_KEYS) {
    const value = config.environment[key];
    if (value == null) delete env[key]; else env[key] = value;
  }
  // Do not persist endpoints which may contain credentials. Fail closed if an
  // operator changes a routing endpoint during a resumable run, rather than
  // silently mixing provider routes. Rotating API keys themselves is allowed.
  for (const key of ROUTE_KEYS) {
    if (config.routeFingerprints[key] !== hash(current[key] ?? null)) {
      throw new Error("Scan provider routing changed; restore the accepted route before resuming this scan.");
    }
  }
  if (!config.aiEnabled) delete env.OPENAI_API_KEY;
  else if (!current.OPENAI_API_KEY?.trim()) throw new Error("The accepted scan requires its configured AI credentials.");
  if (!config.directFallbackEnabled) delete env.OPENAI_DIRECT_FALLBACK_API_KEY;
  else if (!current.OPENAI_DIRECT_FALLBACK_API_KEY?.trim()) throw new Error("The accepted scan requires its configured AI fallback credentials.");
  validateThreadFetchConfiguration(env);
  return env;
}
