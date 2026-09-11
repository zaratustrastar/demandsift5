BEGIN;

-- Context-mode businesses (onboarded by describing their market/idea instead
-- of a website) have no domain to store, so runtime_scans.website_url is ""
-- for them rather than NULL -- every existing reader of that column already
-- treats an empty/unparsable URL as "no identity" (see
-- normalizedBusinessHostname, sameWebsite in the application code), so no
-- change is needed there.
--
-- Continuous monitoring, however, has a hard NOT NULL + non-empty CHECK on
-- website_url that a context-mode business subscribing to monitoring would
-- violate. Relax it to just NOT NULL (still required, just no longer forced
-- non-empty) so monitoring keeps working for both onboarding paths.
ALTER TABLE runtime_monitoring_schedules
  DROP CONSTRAINT IF EXISTS runtime_monitoring_schedules_website_check;

COMMIT;
