-- The template variables a notification was created with.
--
-- A WhatsApp message to a business outside the 24-hour service window must
-- use an approved template, sent as positional variables. They were built
-- only for the first attempt: the sweeper and the dashboard's Resend sent a
-- plain body instead, which WhatsApp rejects, so a notification that failed
-- once could never be delivered. Stored with the row, every attempt sends
-- the same thing.

BEGIN;

ALTER TABLE notifications
  ADD COLUMN template_variables jsonb;

COMMIT;
