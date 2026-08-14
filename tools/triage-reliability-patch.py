from pathlib import Path

provider_path = Path('lib/providers/openai.server.ts')
text = provider_path.read_text()

old = '''  | {
      kind: "model_capacity_fallback";
      operation: AiOperation;
      model: string;
      fallbackModel: string;
    };'''
new = '''  | {
      kind: "model_capacity_fallback" | "model_network_timeout_fallback";
      operation: AiOperation;
      model: string;
      fallbackModel: string;
    };'''
assert old in text, 'diagnostic event marker missing'
text = text.replace(old, new, 1)

old = '''const STRUCTURED_CHAT_MAX_ATTEMPTS = 3;
// Marketplace gateways can temporarily have no seller for an otherwise valid
// model. Retrying those responses over a short backoff window is cheaper and
// safer than failing the entire scan after an immediate burst of requests.
const MARKETPLACE_CAPACITY_RETRY_FLOOR = 5;
const SURPLUS_DEFAULT_ANALYSIS_FALLBACKS = ["gpt-5.5"] as const;'''
new = '''const STRUCTURED_CHAT_MAX_ATTEMPTS = 3;
const TRIAGE_BATCH_SIZE = 8;
// Marketplace gateways can temporarily have no seller for an otherwise valid
// model. Retrying those responses over a short backoff window is cheaper and
// safer than failing the entire scan after an immediate burst of requests.
const MARKETPLACE_CAPACITY_RETRY_FLOOR = 5;
const SURPLUS_DEFAULT_ANALYSIS_FALLBACKS = ["gpt-5.5"] as const;
const SURPLUS_DEFAULT_ECONOMY_FALLBACKS = ["gpt-5.5"] as const;'''
assert old in text, 'provider constants marker missing'
text = text.replace(old, new, 1)

old = '''function isMarketplaceCapacityError(payload: unknown, status: number): boolean {
  if (status !== 530) return false;
  return /no available sellers|seller capacity|capacity unavailable/i.test(
    apiErrorMessage(payload, status),
  );
}

function sleep(milliseconds: number): Promise<void> {'''
new = '''function isMarketplaceCapacityError(payload: unknown, status: number): boolean {
  if (status !== 530) return false;
  return /no available sellers|seller capacity|capacity unavailable/i.test(
    apiErrorMessage(payload, status),
  );
}

function isNetworkTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || /timeout|timed out|aborted due to timeout/i.test(error.message);
}

function sleep(milliseconds: number): Promise<void> {'''
assert old in text, 'marketplace helper marker missing'
text = text.replace(old, new, 1)

old = '''        } catch (error) {
          lastError = new OpenAiProviderError(
            error instanceof Error ? `OpenAI network request failed: ${error.message}` : "OpenAI network request failed.",
          );
          if (attempt < this.maxRetries) {
            await sleep(Math.min(500 * 2 ** attempt, 5_000));
            continue;
          }
          throw lastError;
        }'''
new = '''        } catch (error) {
          lastError = new OpenAiProviderError(
            error instanceof Error ? `OpenAI network request failed: ${error.message}` : "OpenAI network request failed.",
          );
          if (attempt < this.maxRetries) {
            await sleep(Math.min(500 * 2 ** attempt, 5_000));
            continue;
          }
          const fallbackModel = models[modelIndex + 1];
          if (isNetworkTimeoutError(error) && model && fallbackModel) {
            await this.onDiagnostic?.({
              kind: "model_network_timeout_fallback",
              operation,
              model,
              fallbackModel,
            });
            break;
          }
          throw lastError;
        }'''
assert old in text, 'network retry block marker missing'
text = text.replace(old, new, 1)

old = '''  const economyFallbacks = commaSeparatedModels(env.OPENAI_ECONOMY_FALLBACK_MODELS);
  const result: Record<string, string[]> = {};
  const analysis = analysisFallbacks.filter((model) => model !== models.analysisModel);
  const economy = economyFallbacks.filter((model) => model !== models.economyModel);'''
new = '''  const configuredEconomyFallbacks = commaSeparatedModels(env.OPENAI_ECONOMY_FALLBACK_MODELS);
  const economyFallbacks = configuredEconomyFallbacks.length > 0
    ? configuredEconomyFallbacks
    : isSurplusGateway(env.OPENAI_BASE_URL) && models.economyModel === "gpt-5.6-luna"
      ? [...SURPLUS_DEFAULT_ECONOMY_FALLBACKS]
      : [];
  const result: Record<string, string[]> = {};
  const analysis = analysisFallbacks.filter((model) => model !== models.analysisModel);
  const economy = economyFallbacks.filter((model) => model !== models.economyModel);'''
assert old in text, 'economy fallback marker missing'
text = text.replace(old, new, 1)

old = '''    const pending = new Set(expectedIds);
    const collected = new Map<string, TriagedConversation>();
    const attempts: AiProviderResult<TriagedConversation[]>[] = [];
    const retries = Math.max(0, Math.min(request.coverageRetries ?? 2, 3));

    for (let attempt = 0; attempt <= retries && pending.size > 0; attempt += 1) {
      const result = await this.triageAttempt(request, pending);
      attempts.push(result);
      for (const item of result.value) {
        collected.set(item.externalId, item);
        pending.delete(item.externalId);
      }
    }
    if (pending.size > 0) {
      throw new OpenAiProviderError(
        `OpenAI triage coverage remained incomplete after retries; missing externalIds: ${[...pending].join(", ")}.`,
      );
    }'''
new = '''    const collected = new Map<string, TriagedConversation>();
    const attempts: AiProviderResult<TriagedConversation[]>[] = [];
    const retries = Math.max(0, Math.min(request.coverageRetries ?? 2, 3));

    // Keep marketplace requests small enough to finish comfortably inside the
    // provider timeout. One oversized 25-35 candidate JSON response can time out
    // after Reddit discovery has already succeeded and waste the whole scan.
    for (let offset = 0; offset < expectedIds.length; offset += TRIAGE_BATCH_SIZE) {
      const pending = new Set(expectedIds.slice(offset, offset + TRIAGE_BATCH_SIZE));
      for (let attempt = 0; attempt <= retries && pending.size > 0; attempt += 1) {
        const result = await this.triageAttempt(request, pending);
        attempts.push(result);
        for (const item of result.value) {
          collected.set(item.externalId, item);
          pending.delete(item.externalId);
        }
      }
      if (pending.size > 0) {
        throw new OpenAiProviderError(
          `OpenAI triage coverage remained incomplete after retries; missing externalIds: ${[...pending].join(", ")}.`,
        );
      }
    }'''
assert old in text, 'triage coverage block marker missing'
text = text.replace(old, new, 1)
provider_path.write_text(text)

test_path = Path('tests/openai-intelligence-pipeline.test.mjs')
tests = test_path.read_text()

marker = '\ntest("an empty length-limited gateway response is retried inside the AI provider", async () => {'
assert marker in tests, 'batch test insertion marker missing'
batch_test = r'''

test("triage splits large candidate sets into bounded provider requests", async () => {
  const calls = [];
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = JSON.parse(body.messages[1].content);
      const ids = user.candidates.map((row) => row.externalId);
      calls.push(ids);
      return chatResponse({ triage: ids.map(triageItem) });
    },
  });
  const candidates = Array.from({ length: 17 }, (_, index) => candidate(`batch-${index + 1}`));
  const result = await provider.triageConversations({
    business,
    candidates,
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 0,
  });

  assert.deepEqual(calls.map((ids) => ids.length), [8, 8, 1]);
  assert.deepEqual(result.value.map((row) => row.externalId), candidates.map((row) => row.externalId));
});
'''
tests = tests.replace(marker, batch_test + marker, 1)

marker = '\ntest("Surplus gets a high-quality default analysis fallback without affecting other gateways", () => {'
assert marker in tests, 'network fallback insertion marker missing'
network_test = r'''

test("a proven provider timeout falls back once to a configured compatible model", async () => {
  const requestedModels = [];
  const diagnostics = [];
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    maxRetries: 0,
    modelFallbacks: {
      [openai.DEFAULT_OPENAI_MODELS.economyModel]: ["gpt-5.5"],
    },
    onDiagnostic: (event) => diagnostics.push(event),
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      requestedModels.push(body.model);
      if (body.model === openai.DEFAULT_OPENAI_MODELS.economyModel) {
        const error = new Error("The operation was aborted due to timeout");
        error.name = "TimeoutError";
        throw error;
      }
      return chatResponse({ triage: [triageItem("a")] });
    },
  });

  const result = await provider.triageConversations({
    business,
    candidates: [candidate("a")],
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 0,
  });

  assert.deepEqual(requestedModels, [openai.DEFAULT_OPENAI_MODELS.economyModel, "gpt-5.5"]);
  assert.equal(result.model, "gpt-5.5");
  assert.deepEqual(diagnostics, [{
    kind: "model_network_timeout_fallback",
    operation: "conversation_triage",
    model: openai.DEFAULT_OPENAI_MODELS.economyModel,
    fallbackModel: "gpt-5.5",
  }]);
});
'''
tests = tests.replace(marker, network_test + marker, 1)

old = '''test("Surplus gets a high-quality default analysis fallback without affecting other gateways", () => {
  const surplus = openai.openAiModelFallbacksFromEnv({
    OPENAI_BASE_URL: "https://api.surplusintelligence.ai/v1",
    OPENAI_ANALYSIS_MODEL: "gpt-5.6-sol",
  });
  const direct = openai.openAiModelFallbacksFromEnv({
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    OPENAI_ANALYSIS_MODEL: "gpt-5.6-sol",
  });
  assert.deepEqual(surplus, { "gpt-5.6-sol": ["gpt-5.5"] });
  assert.deepEqual(direct, {});
});'''
new = '''test("Surplus gets high-quality default analysis and economy fallbacks without affecting other gateways", () => {
  const surplus = openai.openAiModelFallbacksFromEnv({
    OPENAI_BASE_URL: "https://api.surplusintelligence.ai/v1",
    OPENAI_ANALYSIS_MODEL: "gpt-5.6-sol",
    OPENAI_ECONOMY_MODEL: "gpt-5.6-luna",
  });
  const direct = openai.openAiModelFallbacksFromEnv({
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    OPENAI_ANALYSIS_MODEL: "gpt-5.6-sol",
    OPENAI_ECONOMY_MODEL: "gpt-5.6-luna",
  });
  assert.deepEqual(surplus, {
    "gpt-5.6-sol": ["gpt-5.5"],
    "gpt-5.6-luna": ["gpt-5.5"],
  });
  assert.deepEqual(direct, {});
});'''
assert old in tests, 'default fallback test marker missing'
tests = tests.replace(old, new, 1)
test_path.write_text(tests)
