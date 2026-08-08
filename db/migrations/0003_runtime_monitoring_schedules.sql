BEGIN;

CREATE TABLE runtime_monitoring_schedules (
  workspace_id varchar(96) PRIMARY KEY REFERENCES runtime_workspaces(id) ON DELETE CASCADE,
  seed_scan_id varchar(96) NOT NULL REFERENCES runtime_scans(id) ON DELETE RESTRICT,
  website_url text NOT NULL,
  plan varchar(24) NOT NULL,
  cadence_seconds integer NOT NULL,
  next_run_at timestamptz NOT NULL,
  last_scan_id varchar(96) REFERENCES runtime_scans(id) ON DELETE SET NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_monitoring_schedules_plan_check CHECK (plan IN ('pass', 'core')),
  CONSTRAINT runtime_monitoring_schedules_cadence_check CHECK (cadence_seconds > 0),
  CONSTRAINT runtime_monitoring_schedules_website_check CHECK (length(trim(website_url)) > 0)
);

CREATE INDEX runtime_monitoring_schedules_due_idx
  ON runtime_monitoring_schedules (enabled, next_run_at);

COMMIT;
