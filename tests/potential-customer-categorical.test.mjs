import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

async function compilePotentialCustomers() {
  const source = await readFile(
    new URL("../lib/intelligence/potential-customers.ts", import.meta.url),
    "utf8",
  );
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "potential-customers.ts",
  }).outputText;
  return import(moduleUrl(javascript));
}

const module = await compilePotentialCustomers();

function opportunity(overrides = {}) {
  const id = overrides.id ?? "opp_1";
  return {
    id,
    sourceId: overrides.sourceId ?? `source_${id}`,
    title: "Need a better workflow",
    excerpt: "Our current process is breaking and we need a better solution.",
    subreddit: "smallbusiness",
    author: overrides.author ?? "u/SamePerson",
    permalink: overrides.permalink ?? `https://www.reddit.com/r/smallbusiness/comments/${id}/thread/`,
    postedAt: overrides.sourceCreatedAt ?? "2026-08-08T12:00:00.000Z",
    score: overrides.score ?? 35,
    commentCount: 3,
    whyItMatters: "Current problem",
    intent: overrides.intent ?? "problem-aware",
    recommendedAction: overrides.recommendedAction ?? "monitor",
    communityRisk: overrides.communityRisk ?? "low",
    competitorSignal: null,
    competitorComplaint: false,
    customerProblem: "Broken workflow",
    replyId: `reply_${id}`,
    synthetic: false,
    sourceMode: "apify-test",
    conversationType: "post",
    authorIdentifier: overrides.authorIdentifier ?? "sameperson",
    potentialCustomerIntent: overrides.potentialCustomerIntent ?? "problem_aware",
    qualificationScore: overrides.qualificationScore ?? 5,
    firstSeenAt: "2026-08-08T12:00:00.000Z",
    scanId: "scan_current",
    sourceCreatedAt: overrides.sourceCreatedAt ?? "2026-08-08T12:00:00.000Z",
    supportingSourceIds: [overrides.sourceId ?? `source_${id}`],
    supportingSignalCount: 1,
    appearedInPreviousDemandDrop: false,
    leadStatus: overrides.leadStatus ?? "potential_customer",
    shouldReply: overrides.shouldReply ?? false,
    ...overrides,
  };
}

test("categorical potential customer survives even with a low legacy qualification score", () => {
  const result = module.aggregatePotentialCustomers({
    opportunities: [opportunity({ qualificationScore: 1, score: 42 })],
    scanId: "scan_current",
    windowEndedAt: "2026-08-09T00:00:00.000Z",
    windowDays: 7,
  });
  assert.equal(result.summary.total, 1);
  assert.equal(result.opportunities[0].leadStatus, "potential_customer");
});

test("same Reddit author with multiple conversations becomes one customer card while retaining supporting sources", () => {
  const result = module.aggregatePotentialCustomers({
    opportunities: [
      opportunity({ id: "one", sourceId: "source_one", potentialCustomerIntent: "problem_aware", score: 60 }),
      opportunity({ id: "two", sourceId: "source_two", potentialCustomerIntent: "high_intent", score: 45 }),
    ],
    scanId: "scan_current",
    windowEndedAt: "2026-08-09T00:00:00.000Z",
    windowDays: 7,
  });
  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.conversationCount, 2);
  assert.equal(result.opportunities[0].id, "two", "high-intent signal should be the primary card");
  assert.deepEqual(new Set(result.opportunities[0].supportingSourceIds), new Set(["source_one", "source_two"]));
});

test("high community risk can remain a lead when shouldReply is false", () => {
  const result = module.aggregatePotentialCustomers({
    opportunities: [
      opportunity({
        communityRisk: "high",
        shouldReply: false,
        recommendedAction: "monitor",
        leadStatus: "potential_customer",
      }),
    ],
    scanId: "scan_current",
    windowEndedAt: "2026-08-09T00:00:00.000Z",
    windowDays: 7,
  });
  assert.equal(result.summary.total, 1);
  assert.equal(result.opportunities[0].communityRisk, "high");
  assert.equal(result.opportunities[0].shouldReply, false);
});

test("not_customer never enters customer aggregation regardless of ranking score", () => {
  const result = module.aggregatePotentialCustomers({
    opportunities: [
      opportunity({
        leadStatus: "not_customer",
        score: 100,
        qualificationScore: 100,
        potentialCustomerIntent: "high_intent",
      }),
    ],
    scanId: "scan_current",
    windowEndedAt: "2026-08-09T00:00:00.000Z",
    windowDays: 7,
  });
  assert.equal(result.summary.total, 0);
});
