BEGIN;

-- One provider's Apify Actor failing (most commonly: the Actor is a
-- full-permission Actor that has never been approved for API use in Apify
-- Console -- see apify.com/change-log/full-permission-actors-approval)
-- never fails the whole AI visibility scan; the other two providers'
-- answers are still stored and the scan is still marked "succeeded". Until
-- now that per-provider failure reason was only ever logged to the server
-- console and thrown away, so a user whose scan quietly came back with 0
-- answers for a provider had no way to see why. This column persists the
-- exact reason (including any Apify-supplied approval link) so the AI
-- visibility results view can show it instead of a silent blank.
ALTER TABLE runtime_ai_visibility_scans
  ADD COLUMN IF NOT EXISTS provider_errors jsonb NOT NULL
  DEFAULT '{"chatgpt": null, "gemini": null, "perplexity": null}'::jsonb;

COMMIT;
