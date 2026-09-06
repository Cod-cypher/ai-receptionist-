-- Authentication necessarily happens before a tenant is known: a login form
-- submits an email, not a business id. The same is true of signup (the business
-- does not exist yet) and of refresh-token exchange.
--
-- Rather than let the application bypass row-level security for these, each gets
-- its own policy gated on its own setting, granting the minimum the operation
-- needs. `app.auth_lookup` permits reading the users row an email identifies and
-- managing refresh tokens; `app.signup` permits creating a business and nothing
-- else. Neither can reach a lead, a call or a transcript.

BEGIN;

-- Signup: create the business row. Everything else in registration runs with
-- app.business_id already set, under the normal policies.
CREATE POLICY businesses_signup_insert ON businesses
  FOR INSERT
  WITH CHECK (current_setting('app.signup', true) = 'on');

-- Login: find the account an email belongs to, and record the login time.
CREATE POLICY users_auth_lookup ON users
  FOR SELECT
  USING (current_setting('app.auth_lookup', true) = 'on');

-- Refresh and logout: read a token by its hash, and revoke it.
CREATE POLICY refresh_tokens_auth_lookup ON refresh_tokens
  FOR SELECT
  USING (current_setting('app.auth_lookup', true) = 'on');

CREATE POLICY refresh_tokens_auth_revoke ON refresh_tokens
  FOR UPDATE
  USING (current_setting('app.auth_lookup', true) = 'on');

COMMIT;
