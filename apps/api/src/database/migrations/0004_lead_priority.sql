-- Lead priority and field provenance.
--
-- A highway blowout with a caller who needs help immediately must not sit in
-- the same queue as a driveway jump start, and a detail the receptionist
-- inferred ("Ford" from "Mustang") must not read as one the caller stated.
-- Both are decided in code during the call and stored with the lead.

BEGIN;

ALTER TABLE leads
  ADD COLUMN priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('normal', 'high')),
  ADD COLUMN field_sources jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX leads_business_priority_created_idx
  ON leads (business_id, priority, created_at DESC);

COMMIT;
