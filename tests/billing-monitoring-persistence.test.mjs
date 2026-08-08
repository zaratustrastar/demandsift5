import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [migration, schema, contracts, stripe, repository] = await Promise.all([
  readFile(
    new URL("../db/migrations/0003_runtime_monitoring_schedules.sql", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../db/postgres/schema.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/server/contracts.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/server/stripe.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/server/repository.ts", import.meta.url), "utf8"),
]);

test("monitoring migration pins a due schedule to its workspace and seed scan", () => {
  assert.match(migration, /CREATE TABLE runtime_monitoring_schedules/u);
  assert.match(migration, /workspace_id varchar\(96\) PRIMARY KEY/u);
  assert.match(migration, /seed_scan_id varchar\(96\) NOT NULL REFERENCES runtime_scans/u);
  assert.match(migration, /website_url text NOT NULL/u);
  assert.match(migration, /cadence_seconds integer NOT NULL/u);
  assert.match(migration, /next_run_at timestamptz NOT NULL/u);
  assert.match(migration, /last_scan_id varchar\(96\) REFERENCES runtime_scans\(id\) ON DELETE SET NULL/u);
  assert.match(migration, /enabled boolean NOT NULL DEFAULT true/u);
  assert.match(schema, /runtimeMonitoringSchedules = pgTable\("runtime_monitoring_schedules"/u);
});

test("verified checkout state carries and revalidates the purchased scan", () => {
  assert.match(contracts, /export type CheckoutRecord = \{[\s\S]*?scanId: string;/u);
  assert.match(contracts, /export type EntitlementRecord = \{[\s\S]*?seedScanId: string \| null;[\s\S]*?websiteUrl: string \| null;/u);
  assert.match(stripe, /scanId: input\.scanId/u);
  assert.match(stripe, /purchasedScan\.status === "complete"/u);
  assert.match(repository, /signatureVerified: true/u);
  assert.match(repository, /eq\(runtimeScans\.workspaceId, entitlement\.workspaceId\)/u);
  assert.match(repository, /\.insert\(runtimeMonitoringSchedules\)/u);
  assert.match(repository, /\.set\(\{ enabled: false, updatedAt: committedAt \}\)/u);
  assert.match(repository, /AND attempts < max_attempts/u);
});
