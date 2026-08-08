import type { EntityId, IsoDateTime } from "@/lib/domain/types";

export type AiOperation =
  | "website_analysis"
  | "conversation_classification"
  | "opportunity_ranking"
  | "insight_generation"
  | "reply_generation"
  | "embedding";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
}

/** Prices are intentionally supplied by configuration because provider prices change. */
export interface ModelPrice {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  cachedInputUsdPerMillionTokens?: number;
  cacheWriteInputUsdPerMillionTokens?: number;
}

export type ModelPriceCatalog = Record<string, ModelPrice>;

export interface AiUsageRecord {
  id: EntityId;
  workspaceId: EntityId;
  businessId?: EntityId;
  runId?: EntityId;
  provider: string;
  model: string;
  operation: AiOperation;
  usage: TokenUsage;
  estimatedCostUsd: number;
  occurredAt: IsoDateTime;
  providerRequestId?: string;
}

function nonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Token counts and prices must be finite, non-negative numbers.");
  }
  return value;
}

export function estimateAiCostUsd(usage: TokenUsage, price: ModelPrice): number {
  const cached = nonNegative(usage.cachedInputTokens ?? 0);
  const cacheWrite = nonNegative(usage.cacheWriteInputTokens ?? 0);
  const input = Math.max(0, nonNegative(usage.inputTokens) - cached - cacheWrite);
  const output = nonNegative(usage.outputTokens);
  const cost =
    (input * nonNegative(price.inputUsdPerMillionTokens)) / 1_000_000 +
    (cached * nonNegative(price.cachedInputUsdPerMillionTokens ?? price.inputUsdPerMillionTokens)) /
      1_000_000 +
    (cacheWrite *
      nonNegative(price.cacheWriteInputUsdPerMillionTokens ?? price.inputUsdPerMillionTokens)) /
      1_000_000 +
    (output * nonNegative(price.outputUsdPerMillionTokens)) / 1_000_000;

  return Math.round(cost * 100_000_000) / 100_000_000;
}

export function combineTokenUsage(records: readonly TokenUsage[]): TokenUsage {
  return records.reduce<TokenUsage>(
    (total, current) => ({
      inputTokens: total.inputTokens + current.inputTokens,
      outputTokens: total.outputTokens + current.outputTokens,
      cachedInputTokens: (total.cachedInputTokens ?? 0) + (current.cachedInputTokens ?? 0),
      cacheWriteInputTokens:
        (total.cacheWriteInputTokens ?? 0) + (current.cacheWriteInputTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
  );
}
