BEGIN;

-- Both tables were keyed by workspace_id alone: one settings/schedule row
-- per workspace, full stop. But a single workspace can run scans for
-- several different businesses over time (switching sites, testing
-- multiple products, agencies), and each business needs its own AI
-- Visibility / Reddit monitor settings and results -- not one shared row
-- that whichever business configured monitoring most recently silently
-- overwrites for every other business in the same workspace.
--
-- seed_scan_id has been NOT NULL on both tables since they were created,
-- so this is a pure key-structure change: every existing row already has
-- a valid value for the new key's second column, and since there was only
-- ever one row per workspace before, every existing row trivially
-- satisfies the new (workspace_id, seed_scan_id) uniqueness too. No
-- backfill, no data loss, no risk of a duplicate-key violation.

ALTER TABLE runtime_reddit_monitors DROP CONSTRAINT runtime_reddit_monitors_pkey;
ALTER TABLE runtime_reddit_monitors ADD PRIMARY KEY (workspace_id, seed_scan_id);

ALTER TABLE runtime_ai_visibility_schedules DROP CONSTRAINT runtime_ai_visibility_schedules_pkey;
ALTER TABLE runtime_ai_visibility_schedules ADD PRIMARY KEY (workspace_id, seed_scan_id);

COMMIT;
