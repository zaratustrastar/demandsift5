BEGIN;

-- Google sign-in claims an existing anonymous workspace rather than
-- migrating its data elsewhere: every scan/opportunity/reply table already
-- keys off runtime_workspaces.id, so linking that one row to a real user is
-- enough to make "your account" durable across the 30-day anonymous cookie
-- window. See lib/server/google-oauth.ts and the /api/auth/google/* routes.
--
-- users / auth_accounts / auth_sessions already exist (0001) but have never
-- been used by any application code -- this is the first migration that
-- wires them up. Deliberately not reviving the older workspaces /
-- workspace_members tables (multi-user team workspaces) here: nothing in
-- the current product design needs shared/team workspaces yet, and this
-- keeps the change small and additive.
ALTER TABLE runtime_workspaces
  ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX runtime_workspaces_user_idx ON runtime_workspaces (user_id);

COMMIT;
