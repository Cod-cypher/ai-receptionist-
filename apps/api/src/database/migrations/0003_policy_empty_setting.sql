-- Fixes a subtle interaction between SET LOCAL and connection pooling.
--
-- `current_setting('app.business_id', true)` returns NULL only while the
-- setting has never been defined on that connection. After the first
-- transaction sets it, the GUC becomes known to the session, and at the end of
-- that transaction it reverts to the empty string rather than to NULL. The next
-- request to reuse that pooled connection therefore evaluates
-- ''::uuid, which raises "invalid input syntax for type uuid" instead of simply
-- matching no rows.
--
-- That is fail-closed, but it turns the deliberate unscoped paths (inbound call
-- routing, the notification sweeper, authentication) into hard errors as soon as
-- their connection has served a tenant request. Wrapping the lookup in nullif
-- restores the intended behaviour: no scope means no rows.

BEGIN;

DROP POLICY businesses_tenant_isolation ON businesses;
CREATE POLICY businesses_tenant_isolation ON businesses
  USING (id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.business_id', true), '')::uuid);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'refresh_tokens', 'business_settings', 'services', 'phone_numbers',
    'calls', 'call_events', 'transcripts', 'leads', 'callback_requests',
    'notifications', 'audit_logs'
  ] LOOP
    EXECUTE format('DROP POLICY %I_tenant_isolation ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I
         USING (business_id = nullif(current_setting(''app.business_id'', true), '''')::uuid)
         WITH CHECK (business_id = nullif(current_setting(''app.business_id'', true), '''')::uuid)',
      t, t
    );
  END LOOP;
END $$;

COMMIT;
