-- Initial schema for the AI towing receptionist.
--
-- Tenant isolation is enforced in three places, and this file is the last of
-- them: the application filters by business_id in every repository, a guard
-- populates the tenant context from the JWT, and the row-level security
-- policies below make a query that forgot both return zero rows rather than
-- another towing company's leads.
--
-- The policies key on `current_setting('app.business_id')`, which the
-- application sets with SET LOCAL at the start of every request transaction.
-- The second argument to current_setting suppresses the error when the setting
-- is absent, so an unscoped connection sees nothing at all.

BEGIN;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

CREATE TYPE business_status AS ENUM ('active', 'suspended');
CREATE TYPE user_role AS ENUM ('owner', 'manager', 'agent');
CREATE TYPE receptionist_tone AS ENUM ('professional', 'friendly', 'calm');
CREATE TYPE fallback_behavior AS ENUM ('callback', 'emergency_contact');
CREATE TYPE call_direction AS ENUM ('inbound', 'outbound');
CREATE TYPE call_status AS ENUM ('in_progress', 'completed', 'failed');
CREATE TYPE call_outcome AS ENUM (
  'lead_created', 'callback_created', 'faq_answered', 'abandoned', 'error'
);
CREATE TYPE speaker AS ENUM ('ai', 'customer', 'system');
CREATE TYPE lead_status AS ENUM ('new', 'contacted', 'completed', 'cancelled');
CREATE TYPE callback_status AS ENUM ('open', 'resolved');
CREATE TYPE notification_channel AS ENUM ('whatsapp');
CREATE TYPE notification_status AS ENUM ('pending', 'sent', 'failed', 'dead');

-- ---------------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------------

CREATE TABLE businesses (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  phone                 text,
  website               text,
  address               text,
  timezone              text NOT NULL DEFAULT 'UTC',
  service_areas         jsonb NOT NULL DEFAULT '[]'::jsonb,
  business_hours        jsonb NOT NULL DEFAULT '[]'::jsonb,
  pricing_info          text,
  emergency_contact     text,
  whatsapp_number       text,
  default_region_prefix text,
  status                business_status NOT NULL DEFAULT 'active',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email         text NOT NULL,
  password_hash text NOT NULL,
  name          text NOT NULL,
  role          user_role NOT NULL DEFAULT 'owner',
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));
CREATE INDEX users_business_idx ON users (business_id);

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX refresh_tokens_hash_unique ON refresh_tokens (token_hash);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

CREATE TABLE business_settings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  greeting              text,
  tone                  receptionist_tone NOT NULL DEFAULT 'friendly',
  business_instructions text,
  faq                   jsonb NOT NULL DEFAULT '[]'::jsonb,
  fallback_behavior     fallback_behavior NOT NULL DEFAULT 'callback',
  voice_id              text,
  language              text NOT NULL DEFAULT 'en',
  max_call_seconds      integer NOT NULL DEFAULT 300,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX business_settings_business_unique ON business_settings (business_id);

CREATE TABLE services (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX services_business_idx ON services (business_id);

-- Inbound routing: a call arrives carrying only a destination number, and this
-- is what turns that into a tenant.
CREATE TABLE phone_numbers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  e164         text NOT NULL,
  provider     text NOT NULL DEFAULT 'twilio',
  provider_sid text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX phone_numbers_e164_unique ON phone_numbers (e164);
CREATE INDEX phone_numbers_business_idx ON phone_numbers (business_id);

-- ---------------------------------------------------------------------------
-- Calls
-- ---------------------------------------------------------------------------

CREATE TABLE calls (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider          text NOT NULL DEFAULT 'twilio',
  provider_call_sid text,
  from_number       text NOT NULL,
  to_number         text NOT NULL,
  direction         call_direction NOT NULL DEFAULT 'inbound',
  status            call_status NOT NULL DEFAULT 'in_progress',
  outcome           call_outcome,
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  duration_seconds  integer,
  final_state       text,
  collected_data    jsonb,
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX calls_provider_sid_unique ON calls (provider_call_sid);
CREATE INDEX calls_business_started_idx ON calls (business_id, started_at DESC);
CREATE INDEX calls_from_number_idx ON calls (from_number);
CREATE INDEX calls_business_outcome_idx ON calls (business_id, outcome);

CREATE TABLE call_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  call_id     uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  type        text NOT NULL,
  sequence    integer NOT NULL,
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX call_events_call_sequence_unique ON call_events (call_id, sequence);
CREATE INDEX call_events_business_idx ON call_events (business_id);

CREATE TABLE transcripts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  call_id     uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  turn_index  integer NOT NULL,
  speaker     speaker NOT NULL,
  text        text NOT NULL,
  confidence  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX transcripts_call_turn_unique ON transcripts (call_id, turn_index);
CREATE INDEX transcripts_business_idx ON transcripts (business_id);

-- ---------------------------------------------------------------------------
-- Output
-- ---------------------------------------------------------------------------

-- Nullable columns here mean "the caller did not say". A placeholder string
-- would be indistinguishable from a real answer to the operator reading it.
CREATE TABLE leads (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  call_id           uuid REFERENCES calls(id) ON DELETE SET NULL,
  customer_name     text NOT NULL,
  customer_phone    text NOT NULL,
  service           text NOT NULL,
  location          text NOT NULL,
  destination       text,
  vehicle_make      text,
  vehicle_model     text,
  vehicle_type      text,
  vehicle_condition text,
  vehicle_movable   boolean,
  additional_notes  text,
  source            text NOT NULL DEFAULT 'ai_receptionist',
  status            lead_status NOT NULL DEFAULT 'new',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_business_status_created_idx
  ON leads (business_id, status, created_at DESC);
CREATE INDEX leads_customer_phone_idx ON leads (customer_phone);
CREATE INDEX leads_call_idx ON leads (call_id);

CREATE TABLE callback_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  call_id             uuid REFERENCES calls(id) ON DELETE SET NULL,
  customer_name       text,
  customer_phone      text NOT NULL,
  reason              text NOT NULL,
  transcript_snapshot text,
  status              callback_status NOT NULL DEFAULT 'open',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX callback_requests_business_status_idx
  ON callback_requests (business_id, status, created_at DESC);
CREATE INDEX callback_requests_call_idx ON callback_requests (call_id);

-- A row is written here in the same transaction as the lead it announces,
-- before any network call happens. That ordering is what makes a WhatsApp
-- outage cost a notification rather than a lead.
CREATE TABLE notifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel             notification_channel NOT NULL DEFAULT 'whatsapp',
  target              text NOT NULL,
  lead_id             uuid REFERENCES leads(id) ON DELETE CASCADE,
  callback_request_id uuid REFERENCES callback_requests(id) ON DELETE CASCADE,
  payload             text NOT NULL,
  status              notification_status NOT NULL DEFAULT 'pending',
  attempts            integer NOT NULL DEFAULT 0,
  last_error          text,
  provider_message_id text,
  sent_at             timestamptz,
  next_retry_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_subject_present CHECK (
    lead_id IS NOT NULL OR callback_request_id IS NOT NULL
  )
);
CREATE INDEX notifications_status_retry_idx ON notifications (status, next_retry_at);
CREATE INDEX notifications_business_idx ON notifications (business_id);
CREATE INDEX notifications_lead_idx ON notifications (lead_id);

CREATE TABLE audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  action        text NOT NULL,
  resource_type text NOT NULL,
  resource_id   text,
  ip            text,
  user_agent    text,
  metadata      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_business_created_idx ON audit_logs (business_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'businesses', 'users', 'business_settings', 'services', 'calls',
    'leads', 'callback_requests', 'notifications'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Application role
-- ---------------------------------------------------------------------------

-- The application connects as this role, which is NOT the table owner. Table
-- owners bypass row-level security, so running the app as the owner would
-- silently disable every policy below.
DO $$
BEGIN
  CREATE ROLE towai_app LOGIN PASSWORD 'towai_app';
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'role towai_app already exists, leaving it alone';
END $$;

GRANT USAGE ON SCHEMA public TO towai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO towai_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO towai_app;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

-- The tenant's own row.
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
CREATE POLICY businesses_tenant_isolation ON businesses
  USING (id = current_setting('app.business_id', true)::uuid)
  WITH CHECK (id = current_setting('app.business_id', true)::uuid);

-- Everything else keys on business_id. An unset app.business_id yields NULL,
-- the comparison is NULL, and the row is not visible — which is the behaviour
-- we want for a connection that forgot to scope itself.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'refresh_tokens', 'business_settings', 'services', 'phone_numbers',
    'calls', 'call_events', 'transcripts', 'leads', 'callback_requests',
    'notifications', 'audit_logs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I
         USING (business_id = current_setting(''app.business_id'', true)::uuid)
         WITH CHECK (business_id = current_setting(''app.business_id'', true)::uuid)',
      t, t
    );
  END LOOP;
END $$;

-- Inbound telephony is the one flow that legitimately has no tenant yet: a call
-- arrives and the destination number is what identifies the business. This
-- policy lets the routing lookup run unscoped, and nothing else.
CREATE POLICY phone_numbers_inbound_routing ON phone_numbers
  FOR SELECT
  USING (current_setting('app.routing_lookup', true) = 'on');

COMMIT;
