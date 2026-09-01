import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const experience = await readFile(
  new URL("../components/ThreadlineExperience.tsx", import.meta.url),
  "utf8",
);

test("the save-results screen markets the complete delivered report, not only strict leads", () => {
  assert.match(experience, /function resultMarketingSummary/);
  assert.match(experience, /data\.scanEvidence\?\.candidates/);
  assert.match(experience, /candidate\.triage\.worthEnriching/);
  assert.match(experience, /data\.relevantConversations/);
  assert.match(experience, /data\.metrics\.qualifiedOpportunities/);
  assert.match(experience, /data\.metrics\.readyReplies/);
  assert.match(experience, /data\.metrics\.competitorSignals/);
});

test("a useful report can never be presented as Save your 0 opportunities", () => {
  assert.doesNotMatch(experience, /Save your \{qualifiedOpportunities\}/);
  assert.doesNotMatch(experience, /qualifiedOpportunities=\{dashboardData\.metrics\.qualifiedOpportunities\}/);
  assert.match(experience, /We found \$\{summary\.promisingConversations\} promising Reddit conversation/);
  assert.match(experience, /Save results with Google/);
});

test("the marketing fallback remains truthful when no conversation passed screening", () => {
  assert.match(experience, /We uncovered \$\{usefulFindings\} useful market finding/);
  assert.match(experience, /Your first market scan is complete/);
});
