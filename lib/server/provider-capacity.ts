import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { getDb } from "@/db";
import { abortableDelay } from "@/lib/ai/bounded-dispatcher";
import { RequestGate } from "@/lib/ai/bounded-dispatcher";
import { sharedAiRequestGate } from "@/lib/ai/capacity";

export type ProviderPool = "ai-request" | "apify-actor";

export type ProviderCapacityLease = {
  readonly pool: ProviderPool;
  readonly holderKey: string;
  readonly token: string;
  release(): Promise<boolean>;
};

export type ProviderCapacityAcquire = {
  pool: ProviderPool;
  holderKey: string;
  workspaceId: string;
  limit: number;
  leaseMs: number;
  signal?: AbortSignal;
};

type Database = ReturnType<typeof getDb>;

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Provider capacity must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

export function providerCapacityConfiguration(environment: NodeJS.ProcessEnv = process.env) {
  const enabled = environment.PROVIDER_GLOBAL_CAPS === "1";
  return {
    enabled,
    aiLimit: boundedInteger(environment.AI_GLOBAL_REQUEST_CONCURRENCY, 4, 1, 64),
    apifyActorLimit: boundedInteger(environment.APIFY_GLOBAL_ACTOR_CONCURRENCY, 9, 1, 64),
    pollMs: boundedInteger(environment.PROVIDER_CAPACITY_POLL_MS, 250, 50, 5_000),
    aiLeaseMs: boundedInteger(environment.AI_REQUEST_LEASE_SECONDS, 360, 60, 900) * 1_000,
  };
}

function rows<T>(result: unknown): T[] {
  return Array.isArray(result) ? result as T[] : [];
}

/**
 * PostgreSQL-backed, crash-expiring provider permits. Acquisition is serialized
 * per pool with a transaction advisory lock. The next waiter is chosen from the
 * workspace with the fewest live permits, then FIFO within that workspace.
 */
export class PostgresProviderCapacity {
  constructor(
    private readonly database: Database = getDb(),
    private readonly pollMs = 250,
  ) {}

  async acquire(input: ProviderCapacityAcquire): Promise<ProviderCapacityLease> {
    if (!Number.isInteger(input.limit) || input.limit < 1) throw new Error("Provider capacity limit must be positive.");
    if (!Number.isFinite(input.leaseMs) || input.leaseMs < 1_000) throw new Error("Provider lease must last at least one second.");
    input.signal?.throwIfAborted();
    const waiterId = randomUUID();
    const token = randomUUID();
    const holderKey = input.holderKey.slice(0, 255);
    const workspaceId = input.workspaceId.slice(0, 160);
    await this.database.execute(sql`
      INSERT INTO provider_capacity_waiters (id, pool, holder_key, workspace_id)
      VALUES (${waiterId}::uuid, ${input.pool}, ${holderKey}, ${workspaceId})
      ON CONFLICT (pool, holder_key) DO UPDATE
      SET workspace_id = EXCLUDED.workspace_id,
          expires_at = now() + interval '2 minutes'
    `);

    try {
      while (true) {
        input.signal?.throwIfAborted();
        const acquired = await this.database.transaction(async (transaction) => {
          await transaction.execute(sql`
            SELECT pg_advisory_xact_lock(hashtextextended(${`demandsift:provider-capacity:${input.pool}`}, 0))
          `);
          await transaction.execute(sql`
            UPDATE provider_capacity_waiters
            SET expires_at = now() + interval '2 minutes'
            WHERE id = ${waiterId}::uuid
          `);
          await transaction.execute(sql`
            DELETE FROM provider_capacity_waiters
            WHERE pool = ${input.pool} AND expires_at <= now()
          `);
          await transaction.execute(sql`
            DELETE FROM provider_capacity_leases
            WHERE pool = ${input.pool} AND expires_at <= now()
          `);

          const existing = rows<{ id: string }>(await transaction.execute(sql`
            SELECT id FROM provider_capacity_leases
            WHERE pool = ${input.pool} AND holder_key = ${holderKey}
            LIMIT 1
          `))[0];
          if (existing) {
            await transaction.execute(sql`
              UPDATE provider_capacity_leases
              SET lease_token = ${token}::uuid,
                  workspace_id = ${workspaceId},
                  acquired_at = now(),
                  expires_at = now() + (${input.leaseMs} * interval '1 millisecond')
              WHERE id = ${existing.id}::uuid
            `);
            await transaction.execute(sql`
              DELETE FROM provider_capacity_waiters
              WHERE pool = ${input.pool} AND holder_key = ${holderKey}
            `);
            return true;
          }

          const active = rows<{ total: number | string }>(await transaction.execute(sql`
            SELECT count(*) AS total FROM provider_capacity_leases
            WHERE pool = ${input.pool} AND expires_at > now()
          `))[0];
          if (Number(active?.total ?? 0) >= input.limit) return false;

          const next = rows<{ id: string }>(await transaction.execute(sql`
            SELECT waiter.id
            FROM provider_capacity_waiters AS waiter
            LEFT JOIN LATERAL (
              SELECT count(*) AS active_count
              FROM provider_capacity_leases AS lease
              WHERE lease.pool = waiter.pool
                AND lease.workspace_id = waiter.workspace_id
                AND lease.expires_at > now()
            ) AS workspace_capacity ON true
            WHERE waiter.pool = ${input.pool}
            ORDER BY workspace_capacity.active_count ASC, waiter.enqueued_at ASC, waiter.id ASC
            LIMIT 1
          `))[0];
          if (next?.id !== waiterId) return false;

          await transaction.execute(sql`
            INSERT INTO provider_capacity_leases (
              pool, holder_key, workspace_id, lease_token, expires_at
            ) VALUES (
              ${input.pool}, ${holderKey}, ${workspaceId}, ${token}::uuid,
              now() + (${input.leaseMs} * interval '1 millisecond')
            )
          `);
          await transaction.execute(sql`
            DELETE FROM provider_capacity_waiters WHERE id = ${waiterId}::uuid
          `);
          return true;
        });
        if (acquired) {
          let released = false;
          return {
            pool: input.pool,
            holderKey,
            token,
            release: async () => {
              if (released) return false;
              released = true;
              const result = rows<{ id: string }>(await this.database.execute(sql`
                DELETE FROM provider_capacity_leases
                WHERE pool = ${input.pool}
                  AND holder_key = ${holderKey}
                  AND lease_token = ${token}::uuid
                RETURNING id
              `));
              return result.length > 0;
            },
          };
        }
        await abortableDelay(this.pollMs, input.signal);
      }
    } catch (error) {
      await this.database.execute(sql`
        DELETE FROM provider_capacity_waiters
        WHERE pool = ${input.pool} AND holder_key = ${holderKey}
      `).catch(() => undefined);
      throw error;
    }
  }
}

let sharedCapacity: PostgresProviderCapacity | undefined;

export function sharedProviderCapacity(environment: NodeJS.ProcessEnv = process.env) {
  const configuration = providerCapacityConfiguration(environment);
  if (!configuration.enabled) return null;
  sharedCapacity ??= new PostgresProviderCapacity(getDb(), configuration.pollMs);
  return { capacity: sharedCapacity, configuration };
}

/** A per-workspace local gate composed with process- and account-wide caps. */
export function globallyBoundedAiRequestGate(input: {
  environment?: NodeJS.ProcessEnv;
  workspaceId: string;
  localLimit: number;
  holderPrefix?: string;
}) {
  const environment = input.environment ?? process.env;
  const providerCapacity = sharedProviderCapacity(environment);
  if (!providerCapacity) return undefined;
  return new RequestGate(input.localLimit, {
    run: <T>(operation: () => Promise<T>, signal?: AbortSignal) =>
      sharedAiRequestGate(input.localLimit).run(async () => {
        const lease = await providerCapacity.capacity.acquire({
          pool: "ai-request",
          holderKey: `${input.holderPrefix ?? input.workspaceId}:ai:${randomUUID()}`,
          workspaceId: input.workspaceId,
          limit: providerCapacity.configuration.aiLimit,
          leaseMs: providerCapacity.configuration.aiLeaseMs,
          signal,
        });
        try { return await operation(); }
        finally { await lease.release(); }
      }, signal),
  });
}
