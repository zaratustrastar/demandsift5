BEGIN;

-- AI Visibility questions were regenerated fresh on every weekly run via
-- generateQuestions(), with no persisted, user-manageable configuration --
-- unlike Reddit monitoring's own watch terms (runtime_reddit_monitors),
-- which are a real, editable, persisted list. This column gives AI
-- Visibility the same kind of persistent configuration.
--
-- NULL means this workspace's question set has never been seeded yet
-- (every row before this migration, and every new workspace's first row).
-- The application treats NULL as "generate the initial 3 via the existing
-- generateQuestions() logic, exactly as every run did before this column
-- existed, then persist the result here for reuse." A populated array
-- means the workspace already has a managed set; future runs reuse its
-- active entries and skip generation entirely.
--
-- Deliberately nullable with no default (unlike runtime_ai_visibility_scans
-- .provider_errors, added in migration 0009 with a populated default): an
-- empty array would be indistinguishable from "seeded with zero active
-- questions," which the application never allows as a valid saved state,
-- so NULL is the only unambiguous way to represent "not seeded yet."
--
-- Shape: { text: string; active: boolean }[] | null. Text is the only
-- identity -- no id/versioning. Editing a question's wording is treated as
-- retiring the old text and tracking a new one, not as continuity of the
-- same identity (see AiVisibilityTrackedQuestion in lib/server/contracts.ts).
ALTER TABLE runtime_ai_visibility_schedules
  ADD COLUMN IF NOT EXISTS questions jsonb;

COMMIT;
