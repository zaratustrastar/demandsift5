BEGIN;

-- claimJob (scripts/background-worker.mjs) sorts candidates partly by a
-- LEFT JOIN LATERAL subquery that counts each candidate's "workspace
-- load": how many other jobs for the same workspace are currently
-- running. That subquery's join condition is
--   active_job.status = 'running' AND active_job.payload ->> 'workspaceId' = job.payload ->> 'workspaceId'
-- and it must run once per candidate row before the outer query's
-- ORDER BY ... LIMIT 1 can pick a winner, since the sort depends on its
-- result -- there was previously no index covering either predicate,
-- so this fell back to comparing a JSONB text extraction per row with
-- no index support at all.
--
-- This composite expression index covers both equality predicates
-- (status, then the extracted workspaceId text) so the planner can use
-- an index lookup for the lateral subquery instead of a per-row JSONB
-- comparison. The remaining locked_at > staleBefore condition in the
-- same subquery stays a post-filter on the (now much smaller) matched
-- set -- that's expected and fine; it's a low-selectivity range check
-- on rows already narrowed by two equality lookups.
--
-- Purely additive: no change to claimJob's scheduling semantics, no
-- change to which job gets picked or in what order -- only how cheaply
-- the planner can evaluate the existing condition.
CREATE INDEX background_jobs_status_workspace_idx
  ON background_jobs (status, (payload ->> 'workspaceId'));

COMMIT;
