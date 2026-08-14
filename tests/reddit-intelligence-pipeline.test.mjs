import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

async function compilePipeline() {
  let source = await readFile(
    new URL("../lib/intelligence/reddit-pipeline.ts", import.meta.url),
    "utf8",
  );
  const rankingModule = moduleUrl(`
    export function normalizeSearchText(value) {
      return value
        .normalize("NFKD")
        .replace(/[\\u0300-\\u036f]/g, "")
        .toLowerCase()
        .replace(/https?:\\/\\/\\S+/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\\s+/g, " ");
    }
    export function contentFingerprint(value) {
      const normalized = normalizeSearchText(value);
      let hash = 2166136261;
      for (const character of normalized) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 16777619);
      }
      return Math.abs(hash >>> 0).toString(16).padStart(8, "0");
    }
  `);
  source = source.replaceAll(
    '"./opportunity-ranking"',
    JSON.stringify(rankingModule),
  );
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "reddit-pipeline.ts",
  }).outputText;
  return import(moduleUrl(javascript));
}

const pipeline = await compilePipeline();

const cited = (value) => ({ value, confidence: 0.9, provenanceIds: ["web_1"] });
const business = {
  businessId: "biz_1",
  workspaceId: "ws_1",
  websiteUrl: "https://basecamp.com",
  canonicalDomain: "basecamp.com",
  name: cited("Basecamp"),
  summary: cited("Project management and team collaboration software."),
  productCategory: cited("project management software"),
  targetAudiences: cited([{ name: "small teams", description: "teams", pains: ["scattered work"] }]),
  problemsSolved: cited(["work scattered across apps", "missed project deadlines", "client document tracking"]),
  features: cited([{ name: "project collaboration", description: "organize project work", verified: true }]),
  competitors: cited([{ name: "Asana", relationship: "alternative", verification: "website_claim" }]),
  irrelevantTopics: cited(["travel base camp", "mountain basecamp"]),
  productTerms: cited(["Basecamp", "project management software"]),
  brandTerms: cited(["Basecamp"]),
  customerProblemLanguage: cited(["documents buried in email", "work scattered across apps", "missing client deadlines"]),
  ambiguityRisks: cited(["travel base camp", "mountain basecamp", "hiking basecamp"]),
  version: 2,
  generatedAt: "2026-08-09T00:00:00.000Z",
};

function candidate(overrides = {}) {
  const externalId = overrides.externalId ?? "abc123";
  const title = overrides.title ?? "How do you track monthly client documents?";
  const body = overrides.body ?? "We use Asana but documents keep getting buried in email and deadlines are slipping.";
  return {
    provider: "apify-test",
    sourceMode: "apify-test",
    externalId,
    kind: "post",
    subreddit: "bookkeeping",
    title,
    body,
    author: overrides.author ?? "real_person",
    permalink: overrides.permalink ?? `https://www.reddit.com/r/bookkeeping/comments/${externalId}/thread/`,
    createdAt: overrides.createdAt ?? "2026-08-08T12:00:00.000Z",
    metrics: overrides.metrics ?? { score: 2, comments: 5 },
    matchedQuery: "documents AND buried AND email",
    matchedQueries: ["documents AND buried AND email"],
    discoveryLanes: ["problem_pain"],
    provenance: {
      id: `source_${externalId}`,
      kind: "reddit",
      provider: "apify-test",
      providerExternalId: externalId,
      url: overrides.permalink ?? `https://www.reddit.com/r/bookkeeping/comments/${externalId}/thread/`,
      title,
      excerpt: body.slice(0, 280),
      contentHash: `hash_${externalId}`,
      observedAt: "2026-08-09T00:00:00.000Z",
      isMock: false,
    },
    ...overrides,
  };
}

test("indirect pain reaches AI cleaning even without brand or category mention", () => {
  const row = candidate({
    title: "Solutions for monthly client document and task tracking?",
    body: "Docs get buried in email, tasks are missed, and I keep losing track of monthly client deadlines. Tried Notion and currently use Asana.",
  });
  assert.equal(/basecamp|project management software/i.test(`${row.title} ${row.body}`), false);
  const result = pipeline.cleanDiscoveryCandidates({
    candidates: [row],
    business,
    since: "2026-08-02T00:00:00.000Z",
    now: new Date("2026-08-09T00:00:00.000Z"),
  });
  assert.equal(result.survivors.length, 1);
  assert.equal(Object.values(result.rejectedByReason).reduce((sum, value) => sum + value, 0), 0);
});

test("known Basecamp travel homonym is removed deterministically", () => {
  const row = candidate({
    externalId: "mountain",
    title: "Dusy Basin Basecamp",
    body: "We left our mountain basecamp before sunrise and hiked the traverse.",
    subreddit: "Mountaineering",
  });
  const result = pipeline.cleanDiscoveryCandidates({
    candidates: [row],
    business,
    since: "2026-08-02T00:00:00.000Z",
    now: new Date("2026-08-09T00:00:00.000Z"),
  });
  assert.deepEqual(result.survivors, []);
  assert.equal(result.rejectedByReason.known_homonym, 1);
});

test("topically relevant but noncommercial discussion is not discarded before AI", () => {
  const row = candidate({
    externalId: "academic",
    title: "University paper comparing project management software",
    body: "I am writing a research paper comparing Basecamp and Asana interface patterns. This is not a purchase decision.",
  });
  const result = pipeline.cleanDiscoveryCandidates({
    candidates: [row],
    business,
    since: "2026-08-02T00:00:00.000Z",
    now: new Date("2026-08-09T00:00:00.000Z"),
  });
  assert.equal(result.survivors.length, 1, "AI triage, not deterministic filtering, must decide commercial relevance");
});

test("deterministic cleaning removes obvious job/account-sale/spam noise", () => {
  const rows = [
    candidate({ externalId: "job", body: "We are hiring for a project manager. Apply now with your resume." }),
    candidate({ externalId: "sale", body: "Selling my Fortnite account, DM me on Telegram." }),
    candidate({ externalId: "spam", body: "Limited time offer, use code DEMO50 and WhatsApp me." }),
  ];
  const result = pipeline.cleanDiscoveryCandidates({
    candidates: rows,
    business,
    since: "2026-08-02T00:00:00.000Z",
    now: new Date("2026-08-09T00:00:00.000Z"),
  });
  assert.equal(result.survivors.length, 0);
  assert.equal(result.rejectedByReason.jobs_recruitment, 1);
  assert.equal(result.rejectedByReason.account_sales, 1);
  assert.equal(result.rejectedByReason.spam, 1);
});

test("only AI-triaged worthEnriching candidates enter the enrichment budget", () => {
  const rows = [candidate({ externalId: "a" }), candidate({ externalId: "b" }), candidate({ externalId: "c" })];
  const triage = new Map([
    ["a", { externalId: "a", relevant: true, intent: "actively_looking", demandSignal: "explicit_demand", productFit: "high", timing: "current", replyability: "high", worthEnriching: true, reason: "active request" }],
    ["b", { externalId: "b", relevant: true, intent: "informational", demandSignal: "none", productFit: "medium", timing: "unknown", replyability: "low", worthEnriching: false, reason: "research" }],
    ["c", { externalId: "c", relevant: true, intent: "switching", demandSignal: "switching", productFit: "high", timing: "current", replyability: "medium", worthEnriching: true, reason: "switching" }],
  ]);
  const selected = pipeline.selectCandidatesForEnrichment({ candidates: rows, triageById: triage, budget: 1 });
  assert.equal(selected.length, 1);
  assert.ok(["a", "c"].includes(selected[0].externalId));
  assert.equal(selected.some((row) => row.externalId === "b"), false);
});


test("acquisition zero-result audit escalates only current demand signals", () => {
  const rows = [
    candidate({ externalId: "explicit", discoveryLanes: ["direct_buying_intent"] }),
    candidate({ externalId: "pain", discoveryLanes: ["problem_pain"] }),
    candidate({ externalId: "promo", discoveryLanes: ["direct_buying_intent"] }),
    candidate({ externalId: "noise", discoveryLanes: ["category_recommendation"] }),
  ];
  const triage = new Map([
    ["explicit", { externalId: "explicit", relevant: true, intent: "actively_looking", demandSignal: "explicit_demand", productFit: "low", timing: "current", replyability: "medium", worthEnriching: false, reason: "short snippet leaves fit uncertain" }],
    ["pain", { externalId: "pain", relevant: true, intent: "problem_aware", demandSignal: "pain", productFit: "low", timing: "current", replyability: "low", worthEnriching: false, reason: "pain is real but fit needs context" }],
    ["promo", { externalId: "promo", relevant: false, intent: "promotional", demandSignal: "none", productFit: "low", timing: "current", replyability: "low", worthEnriching: false, reason: "promotion" }],
    ["noise", { externalId: "noise", relevant: false, intent: "irrelevant", demandSignal: "none", productFit: "low", timing: "unknown", replyability: "low", worthEnriching: false, reason: "noise" }],
  ]);

  const selected = pipeline.selectZeroResultAuditCandidates({
    candidates: rows,
    triageById: triage,
    budget: 3,
  });
  assert.deepEqual(selected.map((row) => row.externalId), ["explicit", "pain"]);
});

test("zero-result audit independently checks a high-signal retrieval false negative", () => {
  const rows = [
    candidate({ externalId: "missed", discoveryLanes: ["direct_buying_intent"] }),
    candidate({ externalId: "promo2", discoveryLanes: ["direct_buying_intent"] }),
    candidate({ externalId: "weak", discoveryLanes: ["timing"] }),
  ];
  const triage = new Map([
    ["missed", { externalId: "missed", relevant: false, intent: "irrelevant", demandSignal: "none", productFit: "unknown", timing: "unknown", replyability: "unknown", worthEnriching: false, reason: "cheap triage missed the signal" }],
    ["promo2", { externalId: "promo2", relevant: false, intent: "promotional", demandSignal: "none", productFit: "unknown", timing: "current", replyability: "low", worthEnriching: false, reason: "promotion" }],
    ["weak", { externalId: "weak", relevant: false, intent: "informational", demandSignal: "none", productFit: "unknown", timing: "unknown", replyability: "low", worthEnriching: false, reason: "weak timing-only retrieval" }],
  ]);

  const selected = pipeline.selectZeroResultAuditCandidates({ candidates: rows, triageById: triage, budget: 3 });
  assert.deepEqual(selected.map((row) => row.externalId), ["missed"]);
});

test("ranking happens after categorical qualification and does not change leadStatus", () => {
  const qualification = {
    externalId: "lead",
    leadStatus: "potential_customer",
    demandSignals: ["explicit_demand"],
    intelligenceTags: ["problem_signal", "competitor_intelligence"],
    productFit: "high",
    painSeverity: "high",
    intent: "actively_looking",
    timing: "current",
    evidenceQuality: "high",
    replyability: "low",
    communityRisk: "high",
    problemSummary: "Needs a safer project workflow",
    competitorMentioned: "Asana",
    whyItMatters: "The author is actively seeking a change.",
    shouldReply: false,
    autoReplyAllowed: false,
    requiresHumanReview: true,
    replyAngle: undefined,
    mentionProduct: false,
    disclosureRequired: false,
  };
  const before = qualification.leadStatus;
  const score = pipeline.opportunityRankScore(qualification);
  assert.equal(qualification.leadStatus, before);
  assert.equal(qualification.leadStatus, "potential_customer");
  assert.equal(qualification.shouldReply, false);
  assert.equal(qualification.communityRisk, "high");
  assert.ok(score > 0);
});
