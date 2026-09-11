import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(
  new URL("../lib/intelligence/potential-customers.ts", import.meta.url),
  "utf8",
);
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: "potential-customers.ts",
}).outputText;
const aggregation = await import(
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
);

const scanTime = "2026-08-07T12:00:00.000Z";

function opportunity(id, author, category, overrides = {}) {
  return {
    id: `opp:${id}`,
    sourceId: `source:${id}`,
    title: `Conversation ${id}`,
    excerpt: "I need a better way to solve this problem and I am comparing options.",
    subreddit: "SaaS",
    author,
    permalink: `https://www.reddit.com/r/SaaS/comments/${id}/example/`,
    postedAt: "2026-08-06T12:00:00.000Z",
    score: 80,
    commentCount: 4,
    whyItMatters: "The author describes a verified customer problem.",
    intent: "actively-looking",
    recommendedAction: "reply",
    communityRisk: "low",
    competitorSignal: null,
    competitorComplaint: false,
    customerProblem: "Needs a simpler workflow",
    replyId: `reply:${id}`,
    synthetic: false,
    sourceMode: "apify-test",
    conversationType: "post",
    authorIdentifier: author,
    potentialCustomerIntent: category,
    qualificationScore: 80,
    firstSeenAt: scanTime,
    scanId: "scan:current",
    sourceCreatedAt: "2026-08-06T12:00:00.000Z",
    supportingSourceIds: [`source:${id}`],
    supportingSignalCount: 1,
    appearedInPreviousDemandDrop: false,
    ...overrides,
  };
}

test("counts unique Reddit authors and keeps the strongest intent per person", () => {
  const result = aggregation.aggregatePotentialCustomers({
    opportunities: [
      opportunity("one", "u/BuyerName", "problem_aware", { qualificationScore: 92 }),
      opportunity("two", "buyername", "high_intent", { qualificationScore: 70 }),
      opportunity("three", "BuyerName", "competitor_switching", { qualificationScore: 88 }),
    ],
    scanId: "scan:current",
    windowEndedAt: scanTime,
  });

  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.conversationCount, 3);
  assert.equal(result.opportunities[0].potentialCustomerIntent, "high_intent");
  assert.equal(result.opportunities[0].authorIdentifier, "buyername");
  assert.equal(result.opportunities[0].supportingSignalCount, 3);
});

test("intent buckets are mutually exclusive and add up to the headline count", () => {
  const result = aggregation.aggregatePotentialCustomers({
    opportunities: [
      opportunity("high", "highbuyer", "high_intent"),
      opportunity("switch", "switcher", "competitor_switching"),
      opportunity("aware", "problemholder", "problem_aware"),
    ],
    scanId: "scan:current",
    windowEndedAt: scanTime,
  });

  assert.deepEqual(result.summary.breakdown, {
    highIntent: 1,
    competitorSwitching: 1,
    problemAware: 1,
  });
  assert.equal(
    Object.values(result.summary.breakdown).reduce((sum, count) => sum + count, 0),
    result.summary.total,
  );
});

test("excludes mock, stale, unsafe, non-customer, anonymous and deleted records", () => {
  const result = aggregation.aggregatePotentialCustomers({
    opportunities: [
      opportunity("valid", "realperson", "problem_aware"),
      opportunity("mock", "mockperson", "high_intent", { synthetic: true, sourceMode: "mock" }),
      opportunity("stale", "staleuser", "high_intent", { sourceCreatedAt: "2026-07-01T12:00:00.000Z" }),
      opportunity("risk", "riskyuser", "high_intent", { communityRisk: "high" }),
      opportunity("uncertain", "uncertainuser", "high_intent", { leadStatus: "uncertain" }),
      opportunity("missing", "[deleted]", "high_intent"),
      opportunity("deleted", "formeruser", "high_intent", { excerpt: "[removed]" }),
    ],
    scanId: "scan:current",
    windowEndedAt: scanTime,
  });

  assert.deepEqual(result.opportunities.map((row) => row.authorIdentifier), ["realperson"]);
  assert.equal(result.summary.total, 1);
});

test("Demand Drop metadata distinguishes previously seen people from new people", () => {
  const previous = opportunity("previous", "ReturningBuyer", "problem_aware", {
    scanId: "scan:previous",
    firstSeenAt: "2026-08-01T10:00:00.000Z",
  });
  const result = aggregation.aggregatePotentialCustomers({
    opportunities: [
      opportunity("returning", "returningbuyer", "high_intent"),
      opportunity("new", "newbuyer", "problem_aware"),
    ],
    previousOpportunities: [previous],
    scanId: "scan:current",
    windowEndedAt: scanTime,
  });

  const returning = result.opportunities.find((row) => row.authorIdentifier === "returningbuyer");
  assert.equal(returning?.appearedInPreviousDemandDrop, true);
  assert.equal(returning?.firstSeenAt, "2026-08-01T10:00:00.000Z");
  assert.equal(result.summary.newSincePreviousDemandDrop, 1);
});
