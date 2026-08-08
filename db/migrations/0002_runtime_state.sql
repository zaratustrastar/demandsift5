BEGIN;

CREATE TABLE runtime_workspaces (
  id varchar(96) PRIMARY KEY,
  token_hash varchar(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runtime_workspaces_expires_idx ON runtime_workspaces (expires_at);

CREATE TABLE runtime_scans (
  id varchar(96) PRIMARY KEY,
  workspace_id varchar(96) NOT NULL REFERENCES runtime_workspaces(id) ON DELETE CASCADE,
  website_url text NOT NULL,
  status varchar(24) NOT NULL,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runtime_scans_workspace_created_idx ON runtime_scans (workspace_id, created_at DESC);
CREATE INDEX runtime_scans_status_updated_idx ON runtime_scans (status, updated_at);

CREATE TABLE runtime_replies (
  id varchar(96) PRIMARY KEY,
  workspace_id varchar(96) NOT NULL REFERENCES runtime_workspaces(id) ON DELETE CASCADE,
  scan_id varchar(96) NOT NULL REFERENCES runtime_scans(id) ON DELETE CASCADE,
  status varchar(24) NOT NULL,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runtime_replies_scan_idx ON runtime_replies (scan_id);
CREATE INDEX runtime_replies_workspace_status_idx ON runtime_replies (workspace_id, status);

CREATE TABLE runtime_entitlements (
  workspace_id varchar(96) PRIMARY KEY REFERENCES runtime_workspaces(id) ON DELETE CASCADE,
  plan varchar(24) NOT NULL,
  status varchar(24) NOT NULL,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runtime_entitlements_status_idx ON runtime_entitlements (status, updated_at);

CREATE TABLE runtime_checkouts (
  id varchar(255) PRIMARY KEY,
  workspace_id varchar(96) NOT NULL REFERENCES runtime_workspaces(id) ON DELETE CASCADE,
  plan varchar(24) NOT NULL,
  status varchar(24) NOT NULL,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runtime_checkouts_workspace_status_idx ON runtime_checkouts (workspace_id, status);

CREATE TABLE runtime_conversions (
  id varchar(96) PRIMARY KEY,
  workspace_id varchar(96) NOT NULL REFERENCES runtime_workspaces(id) ON DELETE CASCADE,
  scan_id varchar(96) NOT NULL REFERENCES runtime_scans(id) ON DELETE CASCADE,
  kind varchar(24) NOT NULL,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runtime_conversions_workspace_created_idx ON runtime_conversions (workspace_id, created_at DESC);
CREATE INDEX runtime_conversions_scan_created_idx ON runtime_conversions (scan_id, created_at DESC);

COMMIT;
