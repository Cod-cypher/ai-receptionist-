-- One lead per call.
--
-- A call has two finalisers, the media stream's teardown and Twilio's status
-- callback, and each could read the call as in progress before the other
-- committed. The application now locks the call row while it finishes a
-- call; this index is the backstop, so a second lead for the same call can
-- never be written whatever the code does. A database that already holds
-- duplicates keeps them, and the index is added once they are cleaned up.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT call_id FROM leads WHERE call_id IS NOT NULL GROUP BY call_id HAVING count(*) > 1
  ) THEN
    RAISE NOTICE 'leads has calls with more than one lead; leads_call_unique not created';
  ELSE
    CREATE UNIQUE INDEX leads_call_unique ON leads (call_id) WHERE call_id IS NOT NULL;
  END IF;
END $$;

COMMIT;
