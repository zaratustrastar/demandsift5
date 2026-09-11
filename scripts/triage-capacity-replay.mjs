import { createHash } from "node:crypto";
import { loadTsModule } from "../tests/helpers/load-ts-module.mjs";
import { business, candidate, triage } from "../tests/fixtures/scan-replay/factories.mjs";

const { OpenAiProvider, DEFAULT_OPENAI_MODELS } = await loadTsModule("lib/providers/openai.server.ts");

const corpus = Array.from({ length: 276 }, (_, index) => candidate(`capacity_${index}`, {
  title: index % 3 === 0 ? "Need a document workflow" : index % 3 === 1 ? "Leaving LedgerDesk" : "What client portals get wrong",
  body: index % 3 === 0 ? "We miss client deadlines and need a better system."
    : index % 3 === 1 ? "Our current tool loses checklist updates, so we are comparing alternatives."
      : "Permission models still make collaboration awkward.",
}));

function response(rows) {
  const items = rows.map(row => {
    const index = Number(row.externalId.split("_").at(-1));
    return triage(row.externalId, index % 3 === 2
    ? { intent: "informational", demandSignal: "none", timing: "unknown", replyability: "medium" }
    : index % 3 === 1 ? { intent: "switching", demandSignal: "switching" } : {});
  });
  return new Response(JSON.stringify({ id: "capacity-replay", choices: [{ finish_reason: "stop",
    message: { content: JSON.stringify({ triage: items }) } }],
    usage: { prompt_tokens: rows.length * 90, completion_tokens: rows.length * 45 } }),
  { status: 200, headers: { "content-type": "application/json" } });
}

async function experiment(name, triageBatchSize, requestConcurrency) {
  let active = 0, peak = 0, requests = 0;
  const provider = new OpenAiProvider({ apiKey: "fixture", apiStyle: "chat", maxRetries: 0,
    triageBatchSize, requestConcurrency,
    fetchImpl: async (_url, init) => {
      active++; peak = Math.max(peak, active); requests++;
      const rows = JSON.parse(JSON.parse(init.body).messages[1].content).candidates;
      const delay = 12 + (Number(rows[0].externalId.split("_").at(-1)) % 3) * 3;
      await new Promise(resolve => setTimeout(resolve, delay));
      active--; return response(rows);
    },
  });
  const started = performance.now();
  const result = await provider.triageConversations({ business, candidates: corpus, models: DEFAULT_OPENAI_MODELS,
    compactOutput: true, coverageRetries: 0 });
  const elapsedMs = Math.round((performance.now() - started) * 10) / 10;
  const decisionDigest = createHash("sha256").update(JSON.stringify(result.value.map(row => row.triage))).digest("hex");
  return { name, corpus: corpus.length, triageBatchSize, requestConcurrency, requests, peakRequests: peak, elapsedMs,
    inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, unresolved: result.coverage.unresolved,
    coverageComplete: result.coverage.complete, retries: 0, throttles: 0, decisionDigest };
}

const results = [];
results.push(await experiment("compact_default_capacity", 25, 4));
results.push(await experiment("compact_concurrency_six", 25, 6));
results.push(await experiment("compact_batch_twenty_concurrency_six", 20, 6));
process.stdout.write(`${JSON.stringify({ kind: "deterministic_stub_replay", providerBacked: false, results }, null, 2)}\n`);
