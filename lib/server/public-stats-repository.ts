import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { runtimePublicStats } from "@/db/postgres/schema";
import type { PublicLandingStats } from "@/lib/server/contracts";
import { isProductionRuntime } from "@/lib/server/runtime-env";

/**
 * Read side only. Real, honest landing-page numbers, computed from the
 * same runtime_scans rows the app already writes for every scan -- no new
 * tracking, no new data collection. The write side (the daily refresh) is
 * scripts/background-worker.mjs's runPublicStatsScheduler: that script has
 * no import path into lib/server/*.ts (it talks to Postgres directly via
 * raw SQL, like every other scheduler in it), so the aggregate query and
 * upsert live there, in that file's own established style, not here.
 * This module just reads the cached row (id "landing") that job maintains.
 */

const STATS_ROW_ID = "landing";

function isMemoryStore(): boolean {
  const configured = process.env.STATE_STORE?.trim().toLocaleLowerCase("en-US");
  return configured === "memory" || (!process.env.DATABASE_URL && !isProductionRuntime());
}

export async function getPublicLandingStats(): Promise<PublicLandingStats> {
  if (isMemoryStore()) return { scansAnalyzed: 0, redditPostsAnalyzed: 0, updatedAt: new Date(0).toISOString() };
  const db = getDb();
  const [row] = await db
    .select({
      scansAnalyzed: runtimePublicStats.scansAnalyzed,
      redditPostsAnalyzed: runtimePublicStats.redditPostsAnalyzed,
      updatedAt: runtimePublicStats.updatedAt,
    })
    .from(runtimePublicStats)
    .where(eq(runtimePublicStats.id, STATS_ROW_ID))
    .limit(1);
  if (!row) return { scansAnalyzed: 0, redditPostsAnalyzed: 0, updatedAt: new Date(0).toISOString() };
  return { scansAnalyzed: row.scansAnalyzed, redditPostsAnalyzed: row.redditPostsAnalyzed, updatedAt: row.updatedAt.toISOString() };
}
