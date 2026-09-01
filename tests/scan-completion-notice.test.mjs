import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { scanWorkflowHarness } from "./helpers/scan-workflow-harness.mjs";

const experience = await readFile(new URL("../components/ThreadlineExperience.tsx", import.meta.url), "utf8");
const noticeRoute = await readFile(new URL("../app/api/scans/[scanId]/completion-notice/route.ts", import.meta.url), "utf8");
const emailProvider = await readFile(new URL("../lib/providers/email.server.ts", import.meta.url), "utf8");

test("a completed primary scan persists one content-free unread notice", async t => {
  const fixture = await scanWorkflowHarness(t, { count: 3, stopAtQualification: false });
  const complete = await fixture.workflow.runScan(fixture.scan.id);
  assert.equal(complete.status, "complete");
  assert.deepEqual(Object.keys(complete.completionNotice).sort(), ["createdAt", "readAt", "version"]);
  assert.equal(complete.completionNotice.version, "scan-complete-v1");
  assert.equal(complete.completionNotice.readAt, null);
  assert.equal(complete.completionNotice.createdAt, complete.timing.finishedAt);
  assert.doesNotMatch(JSON.stringify(complete.completionNotice), /reddit|opportun|lead|reply|email/iu);
});

test("monitoring-sidecar scans do not create primary-scan completion alerts", async t => {
  const fixture = await scanWorkflowHarness(t, { count: 2, stopAtQualification: false });
  fixture.scan.scanKind = "monitoring";
  const complete = await fixture.workflow.runScan(fixture.scan.id);
  assert.equal(complete.status, "complete");
  assert.equal(complete.completionNotice, undefined);
});

test("the private return URL stays canonical and notice dismissal is workspace scoped", () => {
  assert.match(experience, /function keepStableScanUrl\(scanId: string/u);
  assert.match(experience, /stable\.searchParams\.set\("scan_id", scanId\)/u);
  assert.match(experience, /keepStableScanUrl\(latest\.scan\.id\)/u);
  assert.match(experience, /\/completion-notice/u);
  assert.match(noticeRoute, /requireWorkspace\(request\)/u);
  assert.match(noticeRoute, /acknowledgeScanCompletion\(scanId, actor\.workspaceId, body\.version\)/u);
  assert.match(noticeRoute, /private, no-store/u);
});

test("production email remains unavailable until a real adapter is registered", () => {
  assert.match(emailProvider, /console email provider is disabled in production/u);
  assert.match(emailProvider, /EMAIL_PROVIDER must select a configured production email provider/u);
  assert.doesNotMatch(experience, /email me when|notify me by email/iu);
});
