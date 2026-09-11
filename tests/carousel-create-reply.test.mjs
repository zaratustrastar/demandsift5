import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dashboard = await readFile(new URL("../components/demand-intelligence/ProductDashboard.tsx", import.meta.url), "utf8");
const experience = await readFile(new URL("../components/ThreadlineExperience.tsx", import.meta.url), "utf8");
const candidateReplyService = await readFile(new URL("../lib/server/candidate-reply-service.ts", import.meta.url), "utf8");
const route = await readFile(
  new URL("../app/api/scans/[scanId]/candidates/[externalId]/reply/route.ts", import.meta.url),
  "utf8",
);

test("the carousel no longer shows a 'Most reliable' badge", () => {
  assert.equal(dashboard.includes("mostReliableBadge"), false);
  assert.equal(dashboard.includes("Most reliable"), false);
});

test("the carousel cards no longer show 'AI reliability' or 'Research signal — not a lead' tags", () => {
  const carouselStart = dashboard.indexOf("function CarouselRelevantCard");
  const carouselEnd = dashboard.indexOf("A Tinder-style, single-card horizontal browser");
  assert.ok(carouselStart > -1 && carouselEnd > carouselStart);
  const carouselCardsSource = dashboard.slice(carouselStart, carouselEnd);
  assert.equal(carouselCardsSource.includes("AI reliability"), false);
  assert.equal(carouselCardsSource.includes("Research signal"), false);
  assert.equal(carouselCardsSource.includes("reliabilityBadge"), false);
});

test("the carousel section is titled 'Reddit posts found:'", () => {
  assert.match(dashboard, /<h2>Reddit posts found:<\/h2>/);
  assert.equal(dashboard.includes("Leads and other relevant conversations"), false);
});

test("a relevant conversation without a reply gets a working Create reply button", () => {
  assert.match(dashboard, /"Create reply"/);
  assert.match(dashboard, /onCreateReply\(/);
  assert.match(experience, /\/api\/scans\/\$\{scanResponse\.scan\.id\}\/candidates\/\$\{encodeURIComponent\(externalId\)\}\/reply/);
});

test("a deep-qualified candidate's real shouldReply decision still gates its reply", () => {
  assert.match(candidateReplyService, /isDeepQualified && qualification\.shouldReply !== true/);
  assert.match(candidateReplyService, /entitlementCoversWebsite/);
  assert.match(route, /createCandidateReply/);
});

test("a lightweight-only (not deep-qualified) candidate gets a reply from triage instead of being refused", () => {
  assert.match(candidateReplyService, /syntheticQualificationFromTriage/);
  assert.match(candidateReplyService, /state\.deepQualification \?\? syntheticQualificationFromTriage\(state\)/);
  // The synthetic path is always copy-and-review, never auto-postable or
  // treated as vetted the way a real deep qualification is.
  assert.match(candidateReplyService, /autoReplyAllowed: false/);
  assert.match(candidateReplyService, /requiresHumanReview: true/);
});
