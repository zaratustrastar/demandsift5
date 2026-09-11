BEGIN;

-- Cross-process provider capacity. These rows are deliberately independent
-- from background_jobs: one scan can own several AI requests and Apify runs,
-- while a reclaimed job must be able to reconcile an already-started Actor.
CREATE TABLE provider_capacity_waiters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool varchar(80) NOT NULL,
  holder_key varchar(255) NOT NULL,
  workspace_id varchar(160) NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '2 minutes',
  UNIQUE (pool, holder_key)
);

CREATE INDEX provider_capacity_waiters_order_idx
  ON provider_capacity_waiters (pool, expires_at, enqueued_at, id);

CREATE TABLE provider_capacity_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool varchar(80) NOT NULL,
  holder_key varchar(255) NOT NULL,
  workspace_id varchar(160) NOT NULL,
  lease_token uuid NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (pool, holder_key)
);

CREATE INDEX provider_capacity_leases_pool_expiry_idx
  ON provider_capacity_leases (pool, expires_at);
CREATE INDEX provider_capacity_leases_workspace_idx
  ON provider_capacity_leases (pool, workspace_id, expires_at);

COMMIT;
