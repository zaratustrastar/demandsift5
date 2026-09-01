// Manual browser QA only. Pause the local worker before seeding; restore before
// restarting it. This never starts provider work and cannot target production.
import postgres from "postgres";
const url = new URL(process.env.DEMANDSIFT_BROWSER_FIXTURE_DATABASE_URL ?? "invalid:");
const [mode, scanId] = process.argv.slice(2);
if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  || !/^\/demandsift_(?:t\d+|browser_fixture)$/.test(url.pathname)
  || !["seed", "restore"].includes(mode) || !/^scan_[a-f0-9]{32}$/.test(scanId ?? "")) {
  throw new Error("Specify a loopback-only demandsift_tN/browser_fixture database, seed|restore, and one fixture scan ID.");
}
const sql = postgres(url.toString(), { max: 1 });
try {
  await sql.begin(async tx => {
    const [row] = await tx`select record from runtime_scans where id = ${scanId} for update`;
    if (!row?.record.contextText?.startsWith("Synthetic progress QA:")) throw new Error("Not a synthetic browser fixture.");
    const current = row.record;
    let record;
    if (mode === "restore") {
      if (!current.browserFixtureRestore) throw new Error("No saved fixture state to restore.");
      record = current.browserFixtureRestore;
    } else {
      if (current.browserFixtureRestore || current.status !== "queued" || !current.approval || current.execution?.active) {
        throw new Error("Only an approved queued fixture with no active execution may be seeded once.");
      }
      const now = Date.now(), time = minutes => new Date(now - minutes * 60000).toISOString();
      record = { ...current, browserFixtureRestore: structuredClone(current), status: "running", phase: "scanning",
        execution: undefined, updatedAt: time(0), analysisCompletedAt: time(36),
        progress: current.progress.map(stage => ["discovery", "triage"].includes(stage.id) ? { ...stage, status: "active" } : stage),
        runtimeProgress: { ...current.runtimeProgress, version: 1, phase: "scanning", acceptedAt: time(40),
          analysisStartedAt: time(37), analysisFinishedAt: time(36), runStartedAt: time(6), finishedAt: null,
          heartbeatAt: time(0), lastWorkAt: time(2), queries: { planned: 9, succeeded: 6, active: 2, retrying: 1, failed: 0, pending: 0 },
          fetched: 240, canonicalEligible: 200, triage: { expected: 200, succeeded: 175, unresolved: 0, pending: 25, promising: 12 },
          deepReview: { target: 8, completed: 0, threadsVerified: 0 }, insights: "pending",
          results: { qualifiedPeople: null, relevantConversations: null, repliesReady: null },
          discoveryComplete: false, triageComplete: false, coverageComplete: false, partialResultsVersion: 0 },
      };
    }
    await tx`update runtime_scans set record = ${tx.json(record)}, status = ${record.status}, updated_at = ${record.updatedAt} where id = ${scanId}`;
    console.log(`${mode}: ${scanId}; synthetic progress only, no provider calls`);
  });
} finally { await sql.end(); }
