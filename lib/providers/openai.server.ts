import type { AiOperation, ModelPrice, ModelPriceCatalog, TokenUsage } from "@/lib/ai/usage";
import { estimateAiCostUsd } from "@/lib/ai/usage";
import type {
  BusinessUnderstanding,
  CitedValue,
  CommunityRisk,
  CompetitorReference,
  EntityId,
  ModelConfiguration,
  OpportunityClassification,
  ProductFeature,
  RecommendedAction,
} from "@/lib/domain/types";
import type {
  AiProvider,
  AiProviderResult,
  AnalyzeBusinessRequest,
  ClassifiedConversation,
  ClassifyConversationsRequest,
  EmbeddingRequest,
  GeneratedInsightSet,
  GeneratedReplyDraft,
  GenerateInsightsRequest,
  GenerateReplyRequest,
} from "@/lib/providers/contracts";

type JsonObject = Record<string, unknown>;
type JsonSchema = Record<string, unknown>;

export const DEFAULT_OPENAI_MODELS: ModelConfiguration = {
  analysisModel: "gpt-5.6-sol",
  economyModel: "gpt-5.6-luna",
  embeddingModel: "text-embedding-3-small",
};

export interface OpenAiUsageEvent {
  workspaceId?: EntityId;
  businessId?: EntityId;
  provider: "openai";
  model: string;
  operation: AiOperation;
  usage: TokenUsage;
  estimatedCostUsd: number;
  providerRequestId?: string;
}

export interface OpenAiProviderOptions {
  apiKey: string;
  baseUrl?: string;
  apiStyle?: "responses" | "chat";
  organization?: string;
  project?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  pricing?: ModelPriceCatalog;
  onUsage?: (event: OpenAiUsageEvent) => void | Promise<void>;
}

interface ResponsesApiPayload {
  id?: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string; refusal?: string }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: {
      cached_tokens?: number;
      cache_read_tokens?: number;
      cache_write_tokens?: number;
    };
  };
}

interface EmbeddingsApiPayload {
  model?: string;
  data?: Array<{ embedding?: number[]; index?: number }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

interface ChatCompletionsPayload {
  id?: string;
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export class OpenAiProviderError extends Error {
  readonly status?: number;
  readonly requestId?: string;

  constructor(message: string, status?: number, requestId?: string) {
    super(message);
    this.name = "OpenAiProviderError";
    this.status = status;
    this.requestId = requestId;
  }
}

const stringSchema = { type: "string" } as const;
const confidenceSchema = { type: "number", minimum: 0, maximum: 1 } as const;
const stringArraySchema = { type: "array", items: stringSchema } as const;

function citedSchema(value: JsonSchema): JsonSchema {
  return {
    type: "object",
    properties: {
      value,
      confidence: confidenceSchema,
      provenanceIds: stringArraySchema,
    },
    required: ["value", "confidence", "provenanceIds"],
    additionalProperties: false,
  };
}

const BUSINESS_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    name: citedSchema(stringSchema),
    summary: citedSchema(stringSchema),
    productCategory: citedSchema(stringSchema),
    targetAudiences: citedSchema({
      type: "array",
      items: {
        type: "object",
        properties: { name: stringSchema, description: stringSchema, pains: stringArraySchema },
        required: ["name", "description", "pains"],
        additionalProperties: false,
      },
    }),
    problemsSolved: citedSchema(stringArraySchema),
    features: citedSchema({
      type: "array",
      items: {
        type: "object",
        properties: { name: stringSchema, description: stringSchema, verified: { type: "boolean" } },
        required: ["name", "description", "verified"],
        additionalProperties: false,
      },
    }),
    competitors: citedSchema({
      type: "array",
      items: {
        type: "object",
        properties: {
          name: stringSchema,
          relationship: { enum: ["direct", "alternative", "category", "unknown"] },
          verification: {
            enum: ["website_claim", "external_provider", "unverified_hypothesis"],
          },
        },
        required: ["name", "relationship", "verification"],
        additionalProperties: false,
      },
    }),
    irrelevantTopics: citedSchema(stringArraySchema),
    productTerms: citedSchema(stringArraySchema),
    customerProblemLanguage: citedSchema(stringArraySchema),
  },
  required: [
    "name",
    "summary",
    "productCategory",
    "targetAudiences",
    "problemsSolved",
    "features",
    "competitors",
    "irrelevantTopics",
    "productTerms",
    "customerProblemLanguage",
  ],
  additionalProperties: false,
};

const CLASSIFICATION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    classifications: {
      type: "array",
      items: {
        type: "object",
        properties: {
          externalId: stringSchema,
          relevance: confidenceSchema,
          buyerIntent: confidenceSchema,
          customerProblem: confidenceSchema,
          competitorComplaint: confidenceSchema,
          semanticSimilarity: confidenceSchema,
          recommendedAction: { enum: ["reply_helpfully", "monitor", "learn", "avoid"] },
          communityRisk: { enum: ["low", "medium", "high", "unknown"] },
          problemSummary: { type: ["string", "null"] },
          competitorMentioned: { type: ["string", "null"] },
          rationale: stringArraySchema,
        },
        required: [
          "externalId",
          "relevance",
          "buyerIntent",
          "customerProblem",
          "competitorComplaint",
          "semanticSimilarity",
          "recommendedAction",
          "communityRisk",
          "problemSummary",
          "competitorMentioned",
          "rationale",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["classifications"],
  additionalProperties: false,
};

const INSIGHTS_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    demandInsights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: {
            enum: [
              "customer_demand",
              "customer_problem",
              "buyer_intent",
              "competitor_gap",
              "search_ai_visibility",
            ],
          },
          title: stringSchema,
          summary: stringSchema,
          implication: stringSchema,
          confidence: confidenceSchema,
          provenanceIds: stringArraySchema,
        },
        required: ["kind", "title", "summary", "implication", "confidence", "provenanceIds"],
        additionalProperties: false,
      },
    },
    competitorSignals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          competitorName: stringSchema,
          signal: stringSchema,
          customerImpact: stringSchema,
          confidence: confidenceSchema,
          provenanceIds: stringArraySchema,
        },
        required: ["competitorName", "signal", "customerImpact", "confidence", "provenanceIds"],
        additionalProperties: false,
      },
    },
  },
  required: ["demandInsights", "competitorSignals"],
  additionalProperties: false,
};

const REPLY_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    body: stringSchema,
    disclosedConnection: { type: "boolean" },
    websiteFactProvenanceIds: stringArraySchema,
  },
  required: ["body", "disclosedConnection", "websiteFactProvenanceIds"],
  additionalProperties: false,
};

function objectValue(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OpenAiProviderError(`OpenAI returned an invalid ${label}.`);
  }
  return value as JsonObject;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new OpenAiProviderError(`OpenAI returned an invalid ${label}.`);
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new OpenAiProviderError(`OpenAI returned an invalid ${label}.`);
  }
  return Math.max(0, Math.min(value, 1));
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new OpenAiProviderError(`OpenAI returned an invalid ${label}.`);
  return value;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new OpenAiProviderError(`OpenAI returned an invalid ${label}.`);
  return value;
}

function stringsValue(value: unknown, label: string): string[] {
  return arrayValue(value, label).map((entry, index) => stringValue(entry, `${label}[${index}]`));
}

function validIds(value: unknown, allowedIds: ReadonlySet<string>, label: string): string[] {
  return [...new Set(stringsValue(value, label).filter((id) => allowedIds.has(id)))];
}

function parseCited<T>(
  value: unknown,
  allowedIds: ReadonlySet<string>,
  label: string,
  parseValue: (input: unknown, label: string) => T,
): CitedValue<T> {
  const object = objectValue(value, label);
  return {
    value: parseValue(object.value, `${label}.value`),
    confidence: numberValue(object.confidence, `${label}.confidence`),
    provenanceIds: validIds(object.provenanceIds, allowedIds, `${label}.provenanceIds`),
  };
}

function audienceValue(value: unknown, label: string): BusinessUnderstanding["targetAudiences"]["value"] {
  return arrayValue(value, label).map((entry, index) => {
    const object = objectValue(entry, `${label}[${index}]`);
    return {
      name: stringValue(object.name, `${label}[${index}].name`),
      description: stringValue(object.description, `${label}[${index}].description`),
      pains: stringsValue(object.pains, `${label}[${index}].pains`),
    };
  });
}

function featureValue(value: unknown, label: string): ProductFeature[] {
  return arrayValue(value, label).map((entry, index) => {
    const object = objectValue(entry, `${label}[${index}]`);
    return {
      name: stringValue(object.name, `${label}[${index}].name`),
      description: stringValue(object.description, `${label}[${index}].description`),
      verified: booleanValue(object.verified, `${label}[${index}].verified`),
    };
  });
}

function competitorValue(value: unknown, label: string): CompetitorReference[] {
  const relationships = new Set<CompetitorReference["relationship"]>([
    "direct", "alternative", "category", "unknown",
  ]);
  const verifications = new Set<CompetitorReference["verification"]>([
    "website_claim", "external_provider", "unverified_hypothesis",
  ]);
  return arrayValue(value, label).map((entry, index) => {
    const object = objectValue(entry, `${label}[${index}]`);
    const relationship = stringValue(object.relationship, `${label}[${index}].relationship`) as CompetitorReference["relationship"];
    const verification = stringValue(object.verification, `${label}[${index}].verification`) as CompetitorReference["verification"];
    if (!relationships.has(relationship) || !verifications.has(verification)) {
      throw new OpenAiProviderError(`OpenAI returned an invalid ${label} enum.`);
    }
    return { name: stringValue(object.name, `${label}[${index}].name`), relationship, verification };
  });
}

function parseBusiness(
  raw: unknown,
  request: AnalyzeBusinessRequest,
  generatedAt: string,
): BusinessUnderstanding {
  const object = objectValue(raw, "business understanding");
  const allowedIds = new Set(request.pages.map((page) => page.sourceId ?? `website:${page.contentHash}`));
  return {
    businessId: request.businessId,
    workspaceId: request.workspaceId,
    websiteUrl: request.websiteUrl,
    canonicalDomain: request.canonicalDomain,
    name: parseCited(object.name, allowedIds, "name", stringValue),
    summary: parseCited(object.summary, allowedIds, "summary", stringValue),
    productCategory: parseCited(object.productCategory, allowedIds, "productCategory", stringValue),
    targetAudiences: parseCited(object.targetAudiences, allowedIds, "targetAudiences", audienceValue),
    problemsSolved: parseCited(object.problemsSolved, allowedIds, "problemsSolved", stringsValue),
    features: parseCited(object.features, allowedIds, "features", featureValue),
    competitors: parseCited(object.competitors, allowedIds, "competitors", competitorValue),
    irrelevantTopics: parseCited(object.irrelevantTopics, allowedIds, "irrelevantTopics", stringsValue),
    productTerms: parseCited(object.productTerms, allowedIds, "productTerms", stringsValue),
    customerProblemLanguage: parseCited(
      object.customerProblemLanguage,
      allowedIds,
      "customerProblemLanguage",
      stringsValue,
    ),
    version: 1,
    generatedAt,
  };
}

function classificationValue(value: unknown, label: string): OpportunityClassification {
  const object = objectValue(value, label);
  const actions = new Set<RecommendedAction>(["reply_helpfully", "monitor", "learn", "avoid"]);
  const risks = new Set<CommunityRisk>(["low", "medium", "high", "unknown"]);
  const recommendedAction = stringValue(object.recommendedAction, `${label}.recommendedAction`) as RecommendedAction;
  const communityRisk = stringValue(object.communityRisk, `${label}.communityRisk`) as CommunityRisk;
  if (!actions.has(recommendedAction) || !risks.has(communityRisk)) {
    throw new OpenAiProviderError("OpenAI returned an invalid opportunity classification enum.");
  }
  const result: OpportunityClassification = {
    relevance: numberValue(object.relevance, `${label}.relevance`),
    buyerIntent: numberValue(object.buyerIntent, `${label}.buyerIntent`),
    customerProblem: numberValue(object.customerProblem, `${label}.customerProblem`),
    competitorComplaint: numberValue(object.competitorComplaint, `${label}.competitorComplaint`),
    semanticSimilarity: numberValue(object.semanticSimilarity, `${label}.semanticSimilarity`),
    recommendedAction,
    communityRisk,
    rationale: stringsValue(object.rationale, `${label}.rationale`),
  };
  if (typeof object.problemSummary === "string") result.problemSummary = object.problemSummary;
  if (typeof object.competitorMentioned === "string") result.competitorMentioned = object.competitorMentioned;
  return result;
}

function parseClassifications(raw: unknown, allowedExternalIds: ReadonlySet<string>): ClassifiedConversation[] {
  const object = objectValue(raw, "classification response");
  const seen = new Set<string>();
  return arrayValue(object.classifications, "classifications").flatMap((entry, index) => {
    const item = objectValue(entry, `classifications[${index}]`);
    const externalId = stringValue(item.externalId, `classifications[${index}].externalId`);
    if (!allowedExternalIds.has(externalId) || seen.has(externalId)) return [];
    seen.add(externalId);
    return [{ externalId, classification: classificationValue(item, `classifications[${index}]`) }];
  });
}

function responseUsage(payload: ResponsesApiPayload): TokenUsage {
  const details = payload.usage?.input_tokens_details;
  return {
    inputTokens: payload.usage?.input_tokens ?? 0,
    outputTokens: payload.usage?.output_tokens ?? 0,
    cachedInputTokens: details?.cached_tokens ?? details?.cache_read_tokens ?? 0,
    cacheWriteInputTokens: details?.cache_write_tokens ?? 0,
  };
}

function responseText(payload: ResponsesApiPayload): string {
  if (payload.status === "incomplete") {
    throw new OpenAiProviderError(
      `OpenAI returned an incomplete response${payload.incomplete_details?.reason ? `: ${payload.incomplete_details.reason}` : "."}`,
    );
  }
  for (const output of payload.output ?? []) {
    if (output.type !== "message") continue;
    for (const content of output.content ?? []) {
      if (content.type === "refusal") {
        throw new OpenAiProviderError(`OpenAI refused the request: ${content.refusal ?? "no reason supplied"}`);
      }
      if (content.type === "output_text" && content.text) return content.text;
    }
  }
  throw new OpenAiProviderError("OpenAI returned no structured response text.");
}

function chatUsage(payload: ChatCompletionsPayload): TokenUsage {
  return {
    inputTokens: payload.usage?.prompt_tokens ?? 0,
    outputTokens: payload.usage?.completion_tokens ?? 0,
  };
}

function chatText(payload: ChatCompletionsPayload): string {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) return content;
  if (Array.isArray(content)) {
    const text = content.map((item) => item.text ?? "").join("");
    if (text.trim()) return text;
  }
  throw new OpenAiProviderError("OpenAI returned no structured chat response text.");
}

function parseStructuredText(text: string, requestId?: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned) as unknown;
  } catch {
    throw new OpenAiProviderError("OpenAI returned malformed structured JSON.", undefined, requestId);
  }
}

function apiErrorMessage(payload: unknown, status: number): string {
  try {
    const object = objectValue(payload, "error response");
    const error = objectValue(object.error, "error response body");
    return typeof error.message === "string" ? error.message : `OpenAI request failed with HTTP ${status}.`;
  } catch {
    return `OpenAI request failed with HTTP ${status}.`;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parsePrice(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("OpenAI model prices must be non-negative numbers.");
  return parsed;
}

export function openAiModelsFromEnv(env: NodeJS.ProcessEnv = process.env): ModelConfiguration {
  return {
    analysisModel: env.OPENAI_ANALYSIS_MODEL?.trim() || DEFAULT_OPENAI_MODELS.analysisModel,
    economyModel: env.OPENAI_ECONOMY_MODEL?.trim() || DEFAULT_OPENAI_MODELS.economyModel,
    embeddingModel: env.OPENAI_EMBEDDING_MODEL?.trim() || DEFAULT_OPENAI_MODELS.embeddingModel,
  };
}

function configuredPrice(env: NodeJS.ProcessEnv, prefix: string, defaults: ModelPrice): ModelPrice {
  return {
    inputUsdPerMillionTokens: parsePrice(env[`${prefix}_INPUT_USD_PER_1M`], defaults.inputUsdPerMillionTokens),
    cachedInputUsdPerMillionTokens: parsePrice(
      env[`${prefix}_CACHED_INPUT_USD_PER_1M`],
      defaults.cachedInputUsdPerMillionTokens ?? defaults.inputUsdPerMillionTokens,
    ),
    cacheWriteInputUsdPerMillionTokens: parsePrice(
      env[`${prefix}_CACHE_WRITE_INPUT_USD_PER_1M`],
      defaults.cacheWriteInputUsdPerMillionTokens ?? defaults.inputUsdPerMillionTokens,
    ),
    outputUsdPerMillionTokens: parsePrice(env[`${prefix}_OUTPUT_USD_PER_1M`], defaults.outputUsdPerMillionTokens),
  };
}

export function openAiPricingFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  models = openAiModelsFromEnv(env),
): ModelPriceCatalog {
  const prices: ModelPriceCatalog = {};
  prices[models.analysisModel] = configuredPrice(env, "OPENAI_ANALYSIS", {
    inputUsdPerMillionTokens: 5,
    cachedInputUsdPerMillionTokens: 0.5,
    cacheWriteInputUsdPerMillionTokens: 6.25,
    outputUsdPerMillionTokens: 30,
  });
  prices[models.economyModel] = configuredPrice(env, "OPENAI_ECONOMY", {
    inputUsdPerMillionTokens: 1,
    cachedInputUsdPerMillionTokens: 0.1,
    cacheWriteInputUsdPerMillionTokens: 1.25,
    outputUsdPerMillionTokens: 6,
  });
  prices[models.embeddingModel] = configuredPrice(env, "OPENAI_EMBEDDING", {
    inputUsdPerMillionTokens: 0.02,
    cachedInputUsdPerMillionTokens: 0.02,
    cacheWriteInputUsdPerMillionTokens: 0.02,
    outputUsdPerMillionTokens: 0,
  });
  return prices;
}

export class OpenAiProvider implements AiProvider {
  readonly name = "openai";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly apiStyle: "responses" | "chat";
  private readonly organization?: string;
  private readonly project?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly pricing: ModelPriceCatalog;
  private readonly onUsage?: OpenAiProviderOptions["onUsage"];

  constructor(options: OpenAiProviderOptions) {
    if (!options.apiKey.trim()) throw new Error("OPENAI_API_KEY is required for the live OpenAI provider.");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.apiStyle = options.apiStyle ?? (
      new URL(this.baseUrl).hostname.toLowerCase() === "api.openai.com" ? "responses" : "chat"
    );
    this.organization = options.organization;
    this.project = options.project;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = Math.max(5_000, Math.min(options.timeoutMs ?? 90_000, 300_000));
    this.maxRetries = Math.max(0, Math.min(options.maxRetries ?? 2, 5));
    this.pricing = options.pricing ?? {};
    this.onUsage = options.onUsage;
  }

  private headers(): HeadersInit {
    return {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
      ...(this.organization ? { "OpenAI-Organization": this.organization } : {}),
      ...(this.project ? { "OpenAI-Project": this.project } : {}),
    };
  }

  private async post(path: string, body: JsonObject): Promise<{ payload: unknown; requestId?: string }> {
    let lastError: OpenAiProviderError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        lastError = new OpenAiProviderError(
          error instanceof Error ? `OpenAI network request failed: ${error.message}` : "OpenAI network request failed.",
        );
        if (attempt < this.maxRetries) {
          await sleep(Math.min(500 * 2 ** attempt, 5_000));
          continue;
        }
        throw lastError;
      }
      const requestId = response.headers.get("x-request-id") ?? undefined;
      const payload = (await response.json().catch(() => null)) as unknown;
      if (response.ok) return { payload, requestId };

      lastError = new OpenAiProviderError(apiErrorMessage(payload, response.status), response.status, requestId);
      const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= this.maxRetries) throw lastError;
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) ? Math.min(retryAfter * 1_000, 10_000) : Math.min(500 * 2 ** attempt, 5_000));
    }
    throw lastError ?? new OpenAiProviderError("OpenAI request failed.");
  }

  private async recordUsage(
    model: string,
    operation: AiOperation,
    usage: TokenUsage,
    context: { workspaceId?: EntityId; businessId?: EntityId },
    providerRequestId?: string,
  ): Promise<number> {
    const price = this.pricing[model];
    const estimatedCostUsd = price ? estimateAiCostUsd(usage, price) : 0;
    await this.onUsage?.({
      ...context,
      provider: "openai",
      model,
      operation,
      usage,
      estimatedCostUsd,
      providerRequestId,
    });
    return estimatedCostUsd;
  }

  private async structured<T>(options: {
    model: string;
    operation: AiOperation;
    schemaName: string;
    schema: JsonSchema;
    system: string;
    user: string;
    maxOutputTokens: number;
    reasoningEffort: "low" | "medium";
    context: { workspaceId?: EntityId; businessId?: EntityId };
    parse: (value: unknown) => T;
  }): Promise<AiProviderResult<T>> {
    const result = this.apiStyle === "chat"
      ? await this.post("/chat/completions", {
          model: options.model,
          messages: [
            {
              role: "system",
              content: `${options.system}\nReturn only valid JSON matching this JSON Schema named ${options.schemaName}. Do not use markdown fences.\n${JSON.stringify(options.schema)}`,
            },
            { role: "user", content: options.user },
          ],
          max_tokens: options.maxOutputTokens,
        })
      : await this.post("/responses", {
          model: options.model,
          input: [
            { role: "system", content: options.system },
            { role: "user", content: options.user },
          ],
          text: {
            format: {
              type: "json_schema",
              name: options.schemaName,
              schema: options.schema,
              strict: true,
            },
          },
          reasoning: { effort: options.reasoningEffort },
          max_output_tokens: options.maxOutputTokens,
          store: false,
        });
    const payload = objectValue(
      result.payload,
      this.apiStyle === "chat" ? "Chat Completions API payload" : "Responses API payload",
    );
    const usage = this.apiStyle === "chat"
      ? chatUsage(payload as ChatCompletionsPayload)
      : responseUsage(payload as ResponsesApiPayload);
    const text = this.apiStyle === "chat"
      ? chatText(payload as ChatCompletionsPayload)
      : responseText(payload as ResponsesApiPayload);
    const parsedJson = parseStructuredText(text, result.requestId);
    const value = options.parse(parsedJson);
    const providerRequestId = typeof payload.id === "string" ? payload.id : result.requestId;
    const estimatedCostUsd = await this.recordUsage(
      options.model,
      options.operation,
      usage,
      options.context,
      providerRequestId,
    );
    return { value, model: options.model, operation: options.operation, usage, estimatedCostUsd, providerRequestId };
  }

  async analyzeBusiness(request: AnalyzeBusinessRequest): Promise<AiProviderResult<BusinessUnderstanding>> {
    const pages = request.pages.map((page) => ({
      sourceId: page.sourceId ?? `website:${page.contentHash}`,
      url: page.url,
      title: page.title,
      description: page.description,
      contentHash: page.contentHash,
      text: page.text.slice(0, 28_000),
    }));
    const generatedAt = new Date().toISOString();
    return this.structured({
      model: request.models.analysisModel,
      operation: "website_analysis",
      schemaName: "business_understanding",
      schema: BUSINESS_SCHEMA,
      maxOutputTokens: 6_000,
      reasoningEffort: "medium",
      context: { workspaceId: request.workspaceId, businessId: request.businessId },
      system:
        "Analyze only the supplied public website evidence. Build a concise business understanding. Cite each fact using only supplied sourceId values. Never invent features, competitors, proof, customers, traffic, rankings, or performance. Mark a feature verified only when the text explicitly supports it. Competitors not explicitly named must be unverified_hypothesis. Return empty arrays when evidence is absent. Irrelevant topics are ambiguity filters for Reddit discovery, not claims about the business.",
      user: JSON.stringify({
        websiteUrl: request.websiteUrl,
        canonicalDomain: request.canonicalDomain,
        pages,
      }),
      parse: (value) => parseBusiness(value, request, generatedAt),
    });
  }

  async classifyConversations(
    request: ClassifyConversationsRequest,
  ): Promise<AiProviderResult<ClassifiedConversation[]>> {
    const allowedIds = new Set(request.conversations.map((conversation) => conversation.externalId));
    return this.structured({
      model: request.models.economyModel,
      operation: "conversation_classification",
      schemaName: "reddit_opportunity_classification",
      schema: CLASSIFICATION_SCHEMA,
      maxOutputTokens: 5_000,
      reasoningEffort: "low",
      context: { workspaceId: request.business.workspaceId, businessId: request.business.businessId },
      system:
        "Classify each supplied Reddit conversation for the supplied business. Scores range from 0 to 1. High relevance requires a concrete overlap with a verified business problem or feature; a keyword alone is insufficient. Buyer intent requires active evaluation or a request for a solution. Community risk rises for promotional hostility, rules uncertainty, sensitive topics, or weak fit. Prefer avoid for irrelevant or unsafe participation. Do not infer facts outside the supplied records. Mock records remain mock.",
      user: JSON.stringify({
        business: request.business,
        conversations: request.conversations.map((conversation) => ({
          externalId: conversation.externalId,
          sourceMode: conversation.sourceMode,
          subreddit: conversation.subreddit,
          title: conversation.title,
          body: conversation.body,
          threadContext: conversation.threadContext,
          metrics: conversation.metrics,
        })),
      }),
      parse: (value) => parseClassifications(value, allowedIds),
    });
  }

  async generateInsights(request: GenerateInsightsRequest): Promise<AiProviderResult<GeneratedInsightSet>> {
    const allowedIds = new Set([
      ...request.opportunities.flatMap((opportunity) => opportunity.provenanceIds),
      ...request.business.name.provenanceIds,
      ...request.business.summary.provenanceIds,
      ...request.business.problemsSolved.provenanceIds,
      ...request.business.features.provenanceIds,
      ...request.business.competitors.provenanceIds,
    ]);
    return this.structured({
      model: request.models.analysisModel,
      operation: "insight_generation",
      schemaName: "demand_insights",
      schema: INSIGHTS_SCHEMA,
      maxOutputTokens: 4_000,
      reasoningEffort: "medium",
      context: { workspaceId: request.business.workspaceId, businessId: request.business.businessId },
      system:
        "Create decision-useful demand insights only from supplied evidence. Cite every insight with one or more allowed provenanceIds. Do not fabricate counts, competitors, customers, traffic, rankings, market size, or outcomes. A competitor signal requires an explicit conversation complaint or comparison. Describe SEO-like ideas only as Search & AI Visibility Opportunities unless an external provider verified performance. Prefer two complete demand insights and at most one strongly evidenced competitor signal over filler.",
      user: JSON.stringify({ business: request.business, opportunities: request.opportunities }),
      parse: (value): GeneratedInsightSet => {
        const object = objectValue(value, "insights response");
        const demandInsights = arrayValue(object.demandInsights, "demandInsights").flatMap((entry, index) => {
          const item = objectValue(entry, `demandInsights[${index}]`);
          const provenanceIds = validIds(item.provenanceIds, allowedIds, `demandInsights[${index}].provenanceIds`);
          if (provenanceIds.length === 0) return [];
          return [{
            businessId: request.business.businessId,
            kind: stringValue(item.kind, `demandInsights[${index}].kind`) as GeneratedInsightSet["demandInsights"][number]["kind"],
            title: stringValue(item.title, `demandInsights[${index}].title`),
            summary: stringValue(item.summary, `demandInsights[${index}].summary`),
            implication: stringValue(item.implication, `demandInsights[${index}].implication`),
            confidence: numberValue(item.confidence, `demandInsights[${index}].confidence`),
            provenanceIds,
          }];
        });
        const competitorSignals = arrayValue(object.competitorSignals, "competitorSignals").flatMap((entry, index) => {
          const item = objectValue(entry, `competitorSignals[${index}]`);
          const provenanceIds = validIds(item.provenanceIds, allowedIds, `competitorSignals[${index}].provenanceIds`);
          if (provenanceIds.length === 0) return [];
          return [{
            businessId: request.business.businessId,
            competitorName: stringValue(item.competitorName, `competitorSignals[${index}].competitorName`),
            signal: stringValue(item.signal, `competitorSignals[${index}].signal`),
            customerImpact: stringValue(item.customerImpact, `competitorSignals[${index}].customerImpact`),
            confidence: numberValue(item.confidence, `competitorSignals[${index}].confidence`),
            provenanceIds,
          }];
        });
        return { demandInsights, competitorSignals };
      },
    });
  }

  async generateReply(request: GenerateReplyRequest): Promise<AiProviderResult<GeneratedReplyDraft>> {
    const allowedWebsiteIds = new Set([
      ...request.business.name.provenanceIds,
      ...request.business.summary.provenanceIds,
      ...request.business.problemsSolved.provenanceIds,
      ...request.business.features.provenanceIds,
    ]);
    return this.structured({
      model: request.models.analysisModel,
      operation: "reply_generation",
      schemaName: "helpful_reddit_reply",
      schema: REPLY_SCHEMA,
      maxOutputTokens: 1_600,
      reasoningEffort: "medium",
      context: { workspaceId: request.business.workspaceId, businessId: request.business.businessId },
      system:
        "Draft a thoughtful Reddit reply. Answer the poster's question first, be specific and useful, and keep promotion secondary. Never invent product features, results, customers, external facts, or personal experience. Mention only website facts supported by supplied provenance IDs. Disclose the business connection naturally whenever the product is mentioned or the affiliation could affect trust. Do not claim to have used a product. Respect community risk and avoid a call-to-action beyond offering relevant information. Return a complete editable reply, not commentary about the reply.",
      user: JSON.stringify({
        business: request.business,
        opportunity: request.opportunity,
        additionalInstructions: request.instructions ?? null,
      }),
      parse: (value): GeneratedReplyDraft => {
        const object = objectValue(value, "reply response");
        return {
          body: stringValue(object.body, "reply.body"),
          disclosedConnection: booleanValue(object.disclosedConnection, "reply.disclosedConnection"),
          websiteFactProvenanceIds: validIds(
            object.websiteFactProvenanceIds,
            allowedWebsiteIds,
            "reply.websiteFactProvenanceIds",
          ),
        };
      },
    });
  }

  async embed(request: EmbeddingRequest): Promise<AiProviderResult<number[][]>> {
    if (request.texts.length === 0 || request.texts.length > 2_048 || request.texts.some((text) => !text.trim())) {
      throw new Error("Embedding requests require between 1 and 2,048 non-empty strings.");
    }
    const result = await this.post("/embeddings", {
      model: request.models.embeddingModel,
      input: request.texts,
      encoding_format: "float",
    });
    const payload = objectValue(result.payload, "Embeddings API payload") as EmbeddingsApiPayload;
    const vectors = (payload.data ?? [])
      .map((entry, position) => ({
        index: entry.index ?? position,
        embedding: entry.embedding,
      }))
      .sort((left, right) => left.index - right.index)
      .map(({ embedding }) => {
        if (!embedding || embedding.some((number) => !Number.isFinite(number))) {
          throw new OpenAiProviderError("OpenAI returned an invalid embedding vector.");
        }
        return embedding;
      });
    if (vectors.length !== request.texts.length) {
      throw new OpenAiProviderError("OpenAI returned the wrong number of embedding vectors.");
    }
    const usage: TokenUsage = {
      inputTokens: payload.usage?.prompt_tokens ?? payload.usage?.total_tokens ?? 0,
      outputTokens: 0,
    };
    const providerRequestId = result.requestId;
    const estimatedCostUsd = await this.recordUsage(
      request.models.embeddingModel,
      "embedding",
      usage,
      { workspaceId: request.workspaceId, businessId: request.businessId },
      providerRequestId,
    );
    return {
      value: vectors,
      model: request.models.embeddingModel,
      operation: "embedding",
      usage,
      estimatedCostUsd,
      providerRequestId,
    };
  }
}

export function createOpenAiProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<OpenAiProviderOptions, "apiKey" | "baseUrl" | "organization" | "project" | "pricing"> = {},
): OpenAiProvider {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for real website analysis and AI generation.");
  return new OpenAiProvider({
    ...options,
    apiKey,
    baseUrl: env.OPENAI_BASE_URL,
    apiStyle:
      env.OPENAI_API_STYLE?.trim().toLowerCase() === "responses"
        ? "responses"
        : env.OPENAI_API_STYLE?.trim().toLowerCase() === "chat"
          ? "chat"
          : undefined,
    organization: env.OPENAI_ORGANIZATION,
    project: env.OPENAI_PROJECT,
    pricing: openAiPricingFromEnv(env),
  });
}
