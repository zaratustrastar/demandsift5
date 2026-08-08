BEGIN;

CREATE TABLE runtime_funnel_events (
  id varchar(96) PRIMARY KEY,
  workspace_id varchar(96) NOT NULL REFERENCES runtime_workspaces(id) ON DELETE CASCADE,
  scan_id varchar(96) NOT NULL REFERENCES runtime_scans(id) ON DELETE CASCADE,
  name varchar(64) NOT NULL,
  potential_customer_count integer,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_funnel_events_count_check
    CHECK (potential_customer_count IS NULL OR potential_customer_count >= 0)
);
CREATE INDEX runtime_funnel_events_workspace_created_idx
  ON runtime_funnel_events (workspace_id, created_at);
CREATE INDEX runtime_funnel_events_scan_name_idx
  ON runtime_funnel_events (scan_id, name, created_at);

COMMIT;
