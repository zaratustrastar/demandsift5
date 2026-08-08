import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(
  new URL("../lib/intelligence/opportunity-ranking.ts", import.meta.url),
  "utf8",
);
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: "opportunity-ranking.ts",
}).outputText;
const ranking = await import(
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
);

function business(overrides = {}) {
  const cited = (value) => ({ value, confidence: 1, provenanceIds: ["website:1"] });
  return {
    productTerms: cited(["Surplus Intelligence", "Models", "Buy", "Sell"]),
    customerProblemLanguage: cited(["lower AI inference costs"]),
    problemsSolved: cited(["route AI requests to lower-cost model capacity"]),
    competitors: cited([]),
    irrelevantTopics: cited([]),
    ...overrides,
  };
}

function conversation(externalId, title, body) {
  return {
    provider: "apify:test",
    sourceMode: "apify-test",
    externalId,
    kind: "post",
    subreddit: "test",
    title,
    body,
    createdAt: "2026-08-07T12:00:00.000Z",
    metrics: { score: 50, comments: 20 },
    provenance: { id: `source:${externalId}` },
  };
}

test("generic buy, sell and review language cannot qualify an unrelated marketplace post", () => {
  const results = ranking.rankConversations(
    [conversation("vinted", "Why avoid users with no reviews?", "Some people only buy and sell items.")],
    business(),
    { now: new Date("2026-08-07T13:00:00.000Z"), minimumScore: 0.075 },
  );
  assert.deepEqual(results, []);
});

test("a concrete business problem can qualify while buyer-intent language alone cannot", () => {
  const results = ranking.rankConversations(
    [
      conversation("relevant", "How can I lower AI inference costs?", "We need to route AI requests to lower-cost model capacity."),
      conversation("generic", "Any recommendations?", "What are people using these days?"),
    ],
    business(),
    { now: new Date("2026-08-07T13:00:00.000Z"), minimumScore: 0.075 },
  );
  assert.deepEqual(results.map((result) => result.conversation.externalId), ["relevant"]);
});
