BEGIN;

-- One cached row of real landing-page numbers (scans analyzed, Reddit posts
-- analyzed), refreshed once a day by a background job. See
-- runtimePublicStats in db/postgres/schema.ts for the full rationale.
CREATE TABLE runtime_public_stats (
  id varchar(32) PRIMARY KEY,
  scans_analyzed integer NOT NULL DEFAULT 0,
  reddit_posts_analyzed integer NOT NULL DEFAULT 0,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seed the singleton row so the first read (before the daily job's first
-- run) gets zeros rather than a missing row, and is immediately due.
INSERT INTO runtime_public_stats (id, next_run_at)
VALUES ('landing', now())
ON CONFLICT (id) DO NOTHING;

COMMIT;
