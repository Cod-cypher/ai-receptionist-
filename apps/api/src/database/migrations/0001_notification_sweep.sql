-- The retry sweeper serves every tenant at once, so it necessarily reads across
-- them. Rather than grant it broad access, this adds a policy as narrow as the
-- job requires: SELECT on notifications only, gated on a setting the sweeper
-- turns on explicitly.
--
-- It cannot read leads, transcripts or calls. The rows it does see are used only
-- to look up (id, business_id), after which delivery proceeds through the normal
-- tenant-scoped path with the full policy set applied.

BEGIN;

CREATE POLICY notifications_retry_sweep ON notifications
  FOR SELECT
  USING (current_setting('app.notification_sweep', true) = 'on');

COMMIT;
