CREATE TABLE IF NOT EXISTS runtime_ai_visibility_schedules (
  workspace_id varchar(96) PRIMARY KEY REFERENCES runtime_workspaces(id) ON DELETE CASCADE,
  seed_scan_id varchar(96) NOT NULL REFERENCES runtime_scans(id) ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT true,
  last_successful_scan_at timestamptz,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_scan_id varchar(96),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_ai_visibility_schedules_due_idx
  ON runtime_ai_visibility_schedules(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS runtime_ai_visibility_scans (
  id varchar(96) PRIMARY KEY,
  workspace_id varchar(96) NOT NULL REFERENCES runtime_workspaces(id) ON DELETE CASCADE,
  seed_scan_id varchar(96) NOT NULL REFERENCES runtime_scans(id) ON DELETE RESTRICT,
  status varchar(24) NOT NULL,
  questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  answers jsonb NOT NULL DEFAULT '[]'::jsonb,
  metrics jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_ai_visibility_scans_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  CONSTRAINT runtime_ai_visibility_scans_questions_check
    CHECK (jsonb_typeof(questions) = 'array'),
  CONSTRAINT runtime_ai_visibility_scans_answers_check
    CHECK (jsonb_typeof(answers) = 'array')
);

ALTER TABLE runtime_ai_visibility_schedules
  DROP CONSTRAINT IF EXISTS runtime_ai_visibility_schedules_last_scan_fk;

ALTER TABLE runtime_ai_visibility_schedules
  ADD CONSTRAINT runtime_ai_visibility_schedules_last_scan_fk
  FOREIGN KEY (last_scan_id) REFERENCES runtime_ai_visibility_scans(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS runtime_ai_visibility_scans_workspace_created_idx
  ON runtime_ai_visibility_scans(workspace_id, created_at DESC);
