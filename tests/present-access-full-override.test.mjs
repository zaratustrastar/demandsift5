import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * TEMPORARY FULL ACCESS OVERRIDE (2026-08-24): every plan-gated capability
 * (reply generation, Reddit posting, Reddit connect, sevenDayMonitoring,
 * continuousMonitoring, resultsTracking) is unlocked for every workspace,
 * per explicit request -- "give just full access, do not concentrate on
 * provisional access" -- while the real free tier is reconsidered later.
 *
 * presentAccess() (lib/server/presenter.ts) is the single function that
 * computes the `access` object every gated route reads (post-to-reddit,
 * reddit/connect both check `access.unlocked`; ThreadlineExperience.tsx's
 * effectiveAccessLevel() reads `access.plan` once unlocked is true). These
 * are source-level checks pinning that both fields are hardcoded to the
 * fully-unlocked state, not derived from the real per-workspace entitlement
 * record anymore -- and that the real per-workspace fields (status,
 * accessUntil, businessWebsiteUrl, seedScanId, verifiedByWebhook) are still
 * read honestly for display/debugging, only the gate itself is bypassed.
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");
const presenterSource = await read("../lib/server/presenter.ts");
const postToRedditRoute = await read("../app/api/replies/[replyId]/post-to-reddit/route.ts");
const redditConnectRoute = await read("../app/api/reddit/connect/route.ts");
const experienceSource = await read("../components/ThreadlineExperience.tsx");

function presentAccessBody() {
  const start = presenterSource.indexOf("export async function presentAccess");
  const end = presenterSource.indexOf("\n}\n", start);
  return presenterSource.slice(start, end);
}

test("presentAccess hardcodes unlocked=true and plan='core', not derived from the real entitlement", () => {
  const body = presentAccessBody();
  assert.match(body, /const unlocked = true;/);
  assert.match(body, /const plan: EntitlementRecord\["plan"\] = "core";/);
  // Not computed by calling entitlementCoversWebsite with the real
  // entitlement/websiteUrl anymore -- both fields are plain constants now.
  assert.equal(/entitlementCoversWebsite\(entitlement/.test(body), false);
});

test("all capabilities key off the hardcoded unlocked/plan, so every capability is true", () => {
  const body = presentAccessBody();
  assert.match(body, /allExistingFindings: unlocked,/);
  assert.match(body, /allSuggestedReplies: unlocked,/);
  assert.match(body, /sevenDayMonitoring: unlocked,/);
  assert.match(body, /continuousMonitoring: unlocked && plan === "core",/);
  assert.match(body, /resultsTracking: unlocked && plan === "core",/);
});

test("real per-workspace fields are still read honestly for display, only the gate is bypassed", () => {
  const body = presentAccessBody();
  assert.match(body, /status: entitlement\.status,/);
  assert.match(body, /accessUntil: entitlement\.accessUntil,/);
  assert.match(body, /businessWebsiteUrl: entitlement\.websiteUrl,/);
  assert.match(body, /seedScanId: entitlement\.seedScanId,/);
  assert.match(body, /verifiedByWebhook: Boolean\(entitlement\.verifiedByEventId\),/);
});

test("post-to-reddit and reddit/connect both gate on access.unlocked, which is now always true", () => {
  assert.match(postToRedditRoute, /if \(!access\.unlocked\)/);
  assert.match(redditConnectRoute, /if \(!access\.unlocked\)/);
});

test("the frontend's effectiveAccessLevel reads access.plan once unlocked, which is now always 'core'", () => {
  assert.match(experienceSource, /return access\?\.unlocked \? access\.plan : "free";/);
});
