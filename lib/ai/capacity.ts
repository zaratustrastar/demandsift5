import { RequestGate } from "./bounded-dispatcher";

export const DEFAULT_AI_TRIAGE_BATCH_SIZE = 25;
export const DEFAULT_AI_REQUEST_CONCURRENCY = 4;

export class AiCapacityConfigurationError extends Error {
  readonly code = "scan_configuration_invalid";
}

function configuredInteger(value: string | number | undefined, name: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || (typeof value === "string" && value.trim() === "")) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AiCapacityConfigurationError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

export function aiCapacityFromEnv(env: Readonly<Record<string, string | undefined>> = process.env) {
  return {
    triageBatchSize: configuredInteger(env.AI_TRIAGE_BATCH_SIZE, "AI_TRIAGE_BATCH_SIZE", DEFAULT_AI_TRIAGE_BATCH_SIZE, 1, 30),
    requestConcurrency: configuredInteger(env.AI_REQUEST_CONCURRENCY, "AI_REQUEST_CONCURRENCY", DEFAULT_AI_REQUEST_CONCURRENCY, 1, 8),
  };
}

export function aiCapacityFromOptions(options: { triageBatchSize?: number; requestConcurrency?: number }) {
  return {
    triageBatchSize: configuredInteger(options.triageBatchSize, "triageBatchSize", DEFAULT_AI_TRIAGE_BATCH_SIZE, 1, 30),
    requestConcurrency: configuredInteger(options.requestConcurrency, "requestConcurrency", DEFAULT_AI_REQUEST_CONCURRENCY, 1, 8),
  };
}

let sharedGate: RequestGate | undefined;

/** One HTTP ceiling for every AI provider created by the process factory.
 * A lower overlapping scan configuration can tighten it; raising requires a
 * worker restart, which avoids silently exceeding a previously accepted cap. */
export function sharedAiRequestGate(limit: number): RequestGate {
  if (!sharedGate) sharedGate = new RequestGate(limit);
  else sharedGate.capAt(limit);
  return sharedGate;
}
