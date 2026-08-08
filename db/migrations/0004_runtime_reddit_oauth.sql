BEGIN;

CREATE TABLE runtime_reddit_connections (
  workspace_id varchar(96) PRIMARY KEY REFERENCES runtime_workspaces(id) ON DELETE CASCADE,
  reddit_user_id varchar(96) NOT NULL,
  username varchar(100) NOT NULL,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runtime_reddit_connections_user_idx
  ON runtime_reddit_connections (reddit_user_id);

CREATE TABLE runtime_reddit_publications (
  reply_id varchar(96) PRIMARY KEY REFERENCES runtime_replies(id) ON DELETE CASCADE,
  workspace_id varchar(96) NOT NULL REFERENCES runtime_workspaces(id) ON DELETE CASCADE,
  status varchar(24) NOT NULL,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_reddit_publications_status_check
    CHECK (status IN ('pending', 'succeeded', 'failed', 'unknown'))
);
CREATE INDEX runtime_reddit_publications_workspace_idx
  ON runtime_reddit_publications (workspace_id, updated_at);

COMMIT;
