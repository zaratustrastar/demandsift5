import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./helpers/load-ts-module.mjs";

const live = await loadTsModule("components/demand-intelligence/live-scan.ts");

function snapshot(version, { previews = [], opportunities = [], relevantConversations = [], replies = [], replyStates = [] } = {}) {
  return { schemaVersion: 1, version, updatedAt: `2026-09-01T00:00:0${version}.000Z`, snapshot: true, complete: false,
    previews, opportunities, relevantConversations, replies, replyStates, sources: [], tombstones: [],
    foundSoFar: { reviewedCandidates: previews.length, qualifiedPeople: opportunities.length,
      relevantConversations: relevantConversations.length, repliesReady: replies.length } };
}

const preview = (id, version, postedAt = "2026-09-01T00:00:00.000Z") => ({ id, version, kind: "candidate_preview",
  state: "ready", qualificationStatus: "pending", externalId: id, sourceId: `source_${id}`, title: id, excerpt: id,
  subreddit: "saas", author: id, permalink: `https://reddit.com/${id}`, postedAt, intent: "actively_looking",
  demandSignal: "explicit_demand", problem: "Need", productFit: "high", sourceMode: "live" });
const opportunity = (id, outputVersion, score = 50) => ({ id, outputVersion, qualificationScore: score,
  postedAt: "2026-09-01T00:00:00.000Z" });

test("live partial merge ignores late snapshots and keeps existing visual order", () => {
  const first = live.mergeLivePartialState(null, snapshot(1, { previews: [preview("a", 1), preview("b", 1)] }));
  const second = live.mergeLivePartialState(first, snapshot(2, { previews: [preview("b", 1), preview("a", 2), preview("c", 2)] }));
  assert.deepEqual(second.previews.map(row => row.id), ["a", "b", "c"]);
  assert.equal(second.previews[0].version, 2);
  assert.equal(second.newResultsSinceOrder, 1);
  assert.equal(live.mergeLivePartialState(second, snapshot(1, { previews: [] })), second);
});

test("authoritative snapshots remove tombstoned rows and append qualified replacements", () => {
  const first = live.mergeLivePartialState(null, snapshot(1, { previews: [preview("candidate", 1)] }));
  const second = live.mergeLivePartialState(first, snapshot(2, { opportunities: [opportunity("lead", 2, 70)] }));
  assert.deepEqual(second.previews, []);
  assert.deepEqual(second.opportunities.map(row => row.id), ["lead"]);
  assert.equal(second.newResultsSinceOrder, 1);
});

test("explicit ordering refresh ranks stable rows and clears the announcement count", () => {
  const initial = live.mergeLivePartialState(null, snapshot(1, { opportunities: [opportunity("low", 1, 10)] }));
  const appended = live.mergeLivePartialState(initial, snapshot(2, {
    opportunities: [opportunity("high", 2, 90), opportunity("low", 1, 10)],
  }));
  assert.deepEqual(appended.opportunities.map(row => row.id), ["low", "high"]);
  const refreshed = live.refreshLiveResultOrder(appended);
  assert.deepEqual(refreshed.opportunities.map(row => row.id), ["high", "low"]);
  assert.equal(refreshed.newResultsSinceOrder, 0);
});

test("user-edited live drafts win when the completed report replaces the shell", () => {
  const report = { opportunities: [{ id: "lead", reply: { id: "reply_lead", draft: "server draft" } }],
    relevantConversations: [{ id: "research", reply: { id: "reply_research", draft: "research draft" } }] };
  const preserved = live.preserveLiveReplyEdits(report, { reply_lead: "edited draft" });
  assert.equal(preserved.opportunities[0].reply.draft, "edited draft");
  assert.equal(preserved.relevantConversations[0].reply.draft, "research draft");
  assert.equal(report.opportunities[0].reply.draft, "server draft", "server-backed object is not mutated");
});
