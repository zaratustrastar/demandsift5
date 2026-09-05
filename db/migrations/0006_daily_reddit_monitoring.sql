CREATE TABLE IF NOT EXISTS runtime_reddit_monitors (
  workspace_id varchar(96) PRIMARY KEY REFERENCES runtime_workspaces(id) ON DELETE CASCADE,
  seed_scan_id varchar(96) NOT NULL REFERENCES runtime_scans(id) ON DELETE RESTRICT,
  website_url text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  watch_terms jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_successful_monitor_at timestamptz,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_run_id varchar(96),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_reddit_monitors_terms_check
    CHECK (jsonb_typeof(watch_terms) = 'array'),
  CONSTRAINT runtime_reddit_monitors_website_check
    CHECK (length(trim(website_url)) > 0)
);

CREATE INDEX IF NOT EXISTS runtime_reddit_monitors_due_idx
  ON runtime_reddit_monitors(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS runtime_reddit_monitor_runs (
  id varchar(96) PRIMARY KEY,
  workspace_id varchar(96) NOT NULL REFERENCES runtime_workspaces(id) ON DELETE CASCADE,
  seed_scan_id varchar(96) NOT NULL REFERENCES runtime_scans(id) ON DELETE RESTRICT,
  scan_id varchar(96) REFERENCES runtime_scans(id) ON DELETE SET NULL,
  status varchar(24) NOT NULL,
  window_started_at timestamptz NOT NULL,
  window_ended_at timestamptz NOT NULL,
  actor_run_id varchar(160),
  record jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_reddit_monitor_runs_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  CONSTRAINT runtime_reddit_monitor_runs_window_check
    CHECK (window_ended_at >= window_started_at)
);

ALTER TABLE runtime_reddit_monitors
  DROP CONSTRAINT IF EXISTS runtime_reddit_monitors_last_run_fk;

ALTER TABLE runtime_reddit_monitors
  ADD CONSTRAINT runtime_reddit_monitors_last_run_fk
  FOREIGN KEY (last_run_id) REFERENCES runtime_reddit_monitor_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS runtime_reddit_monitor_runs_workspace_created_idx
  ON runtime_reddit_monitor_runs(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS runtime_reddit_monitor_matches (
  workspace_id varchar(96) NOT NULL REFERENCES runtime_workspaces(id) ON DELETE CASCADE,
  provider varchar(100) NOT NULL,
  external_id varchar(255) NOT NULL,
  canonical_url text,
  source_created_at timestamptz NOT NULL,
  matched_terms jsonb NOT NULL DEFAULT '[]'::jsonb,
  first_run_id varchar(96) NOT NULL REFERENCES runtime_reddit_monitor_runs(id) ON DELETE RESTRICT,
  last_run_id varchar(96) NOT NULL REFERENCES runtime_reddit_monitor_runs(id) ON DELETE RESTRICT,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  outcome varchar(32) NOT NULL DEFAULT 'unreviewed',
  record jsonb NOT NULL,
  PRIMARY KEY (workspace_id, provider, external_id),
  CONSTRAINT runtime_reddit_monitor_matches_terms_check
    CHECK (jsonb_typeof(matched_terms) = 'array'),
  CONSTRAINT runtime_reddit_monitor_matches_outcome_check
    CHECK (outcome IN ('unreviewed', 'irrelevant', 'relevant', 'opportunity'))
);

CREATE INDEX IF NOT EXISTS runtime_reddit_monitor_matches_run_idx
  ON runtime_reddit_monitor_matches(last_run_id);

