import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const experience = await readFile(
  new URL("../components/ThreadlineExperience.tsx", import.meta.url),
  "utf8",
);
const dashboard = await readFile(
  new URL("../components/demand-intelligence/ProductDashboard.tsx", import.meta.url),
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
  assert.doesNotMatch(experience, /statusLabel="Save your results"/);
  assert.doesNotMatch(experience, /statusLabel="All set"/);
});

test("the marketing fallback remains truthful when no conversation passed screening", () => {
  assert.match(experience, /We uncovered \$\{usefulFindings\} useful market finding/);
  assert.match(experience, /Your first market scan is complete/);
});

test("the completed report no longer opens a saved-scan popup", () => {
  assert.doesNotMatch(experience, /Your Market Scan is complete and saved/);
  assert.doesNotMatch(experience, /acknowledgeCompletionNotice/);
});

test("overview leads with positive delivered value instead of strict zero subsets", () => {
  assert.match(dashboard, /label: "Promising conversations"/);
  assert.match(dashboard, /value: carouselItems\.length/);
  assert.match(dashboard, /label: "Replies ready"/);
  assert.match(dashboard, /label: "Market insights"/);
  assert.match(dashboard, /label: "Reddit posts reviewed"/);
  assert.match(dashboard, /filter\(\(metric\) => metric\.value > 0\)\.slice\(0, 4\)/);
  assert.doesNotMatch(dashboard, />Opportunities found</);
  assert.doesNotMatch(dashboard, />Qualified this scan</);
});
