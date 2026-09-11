import { readFile } from "node:fs/promises";

export const fixtures = JSON.parse(await readFile(new URL("./scenarios.json", import.meta.url), "utf8"));
const cited = (value) => ({ value, confidence: 0.9, provenanceIds: ["fixture_website"] });
export const business = {
  businessId: "fixture_business", workspaceId: "fixture_workspace",
  websiteUrl: "https://ledger-workflow.example", canonicalDomain: "ledger-workflow.example",
  name: cited("Ledger Workflow"), summary: cited("Client document and deadline tracking for accounting teams."),
  productCategory: cited("client document tracking"), targetAudiences: cited([]),
  problemsSolved: cited(["missed client deadlines", "documents buried in email"]),
  features: cited([{ name: "client deadline tracker", description: "track requested documents", verified: true }]),
  competitors: cited([{ name: "LedgerDesk", relationship: "alternative", verification: "website_claim" }]),
  irrelevantTopics: cited(["hiking basecamp"]), ambiguityRisks: cited(["mountain base camp"]),
  productTerms: cited(["client document tracking"]), brandTerms: cited(["Ledger Workflow"]),
  customerProblemLanguage: cited(["missed client deadlines", "documents buried in email"]),
  version: 2, generatedAt: fixtures.now,
};

export function candidate(id, overrides = {}) {
  return {
    provider: "fixture", sourceMode: "mock", externalId: id, kind: "post", subreddit: "fixture_accounting",
    title: `Client document issue ${id}`, body: `We need to track client deadlines and attachments. Fixture reference ${id}.`,
    author: `fixture_author_${id}`, permalink: `https://www.reddit.com/r/fixture_accounting/comments/${id}/fixture/`,
    createdAt: "2026-08-29T12:00:00.000Z", metrics: { score: 2, comments: 3 },
    matchedQuery: "client document tracking", matchedQueries: ["client document tracking"],
    discoveryLanes: ["direct_buying_intent"],
    provenance: { id: `fixture_source_${id}`, kind: "reddit", provider: "fixture", providerExternalId: id,
      url: `https://www.reddit.com/r/fixture_accounting/comments/${id}/fixture/`,
      contentHash: `fixture_hash_${id}`, observedAt: fixtures.now, isMock: true },
    ...overrides,
  };
}

export function triage(id, overrides = {}) {
  return { externalId: id, relevant: true, intent: "actively_looking", demandSignal: "explicit_demand",
    problem: "Missed client deadlines", productFit: "high", timing: "current", replyability: "high",
    worthEnriching: true, reason: "Synthetic fixture label; not a real model evaluation.", ...overrides };
}

export function chatResponse(items) {
  return new Response(JSON.stringify({ id: "fixture_request",
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ triage: items }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

export function requestCandidates(init) {
  return JSON.parse(JSON.parse(init.body).messages[1].content).candidates;
}
