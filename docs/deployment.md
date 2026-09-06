# Deployment

## What runs

| | |
|---|---|
| API | Node 22, stateless apart from live call sessions in Redis |
| Dashboard | Static bundle behind nginx, `/api` proxied to the API |
| Postgres | 16+ (18 in the compose stack) |
| Redis | Live call state and rate limiting |

```bash
docker compose up -d --build
```

Images: API 381MB, dashboard 74MB. The API runs as the non-root `node` user and
carries no compiler toolchain.

---

## Configuration that must be right

### Two database URLs, and they are not interchangeable

```bash
DATABASE_URL=postgres://towai_app:...@host:5432/towai            # application
DATABASE_MIGRATION_URL=postgres://owner:...@host:5432/towai      # migrations
```

Postgres lets **table owners bypass row-level security**. Pointing
`DATABASE_URL` at the owner disables every tenant-isolation policy, and nothing
visibly breaks — the application keeps working, and one towing company becomes
able to read another's leads the first time a query forgets its `business_id`
filter.

Change `towai_app`'s password from the migration default before going live:

```sql
ALTER ROLE towai_app WITH PASSWORD '<generated>';
```

### Secrets

```bash
openssl rand -base64 48   # JWT_ACCESS_SECRET
openssl rand -base64 48   # JWT_REFRESH_SECRET
```

Both are validated as at least 32 characters at boot. Use your platform's secret
store; never bake them into an image. Rotating `JWT_ACCESS_SECRET` invalidates
access tokens (users re-authenticate silently via refresh); rotating
`JWT_REFRESH_SECRET` signs everyone out.

### The production guards

The config schema **refuses to boot** under `NODE_ENV=production` if:

- `ENABLE_DEV_SIMULATOR=true` — an unauthenticated endpoint that starts calls
  and creates leads
- `TWILIO_VALIDATE_SIGNATURE=false` — without it, anyone who can reach the
  webhook can forge calls, generate leads, and send WhatsApp messages on the
  operator's account

It also refuses to start with a provider selected but its credentials missing, so
that is a failed deploy rather than a caller hearing silence.

### Public URL

```bash
PUBLIC_BASE_URL=https://api.yourdomain.com
```

Twilio signs each request against the URL it called. This must match exactly —
scheme, host, and any path prefix — or every webhook returns 403. If a proxy
rewrites paths, this is the externally visible URL, not the internal one.

---

## Migrations

Run as a pre-deploy job, as the owner role, before the new version starts:

```bash
DATABASE_MIGRATION_URL=... node apps/api/dist/database/migrate.js
```

Migrations are plain SQL applied in filename order and tracked in
`schema_migrations`. Each file manages its own transaction, so a failure leaves
the schema at the last complete migration.

The row-level security policies live in the same migrations as the tables they
protect, so there is never a window where a table exists unprotected.

---

## Scaling

The API is stateless except for live call sessions, which are in Redis keyed by
call id. Run as many instances as you like behind a load balancer.

**No sticky sessions needed for `<Gather>`.** Consecutive webhooks for one call
routinely land on different instances; the session is loaded from Redis, and if
that misses, rebuilt from Postgres. A restart mid-call costs conversational
nuance, not the caller's answers.

**Media Streams needs the WebSocket to stay put** for the life of a call, which
is what a normal load balancer does anyway. Set the idle timeout above your
longest expected call (`maxCallSeconds`, default 300).

**Drain before terminating.** A call is a live conversation, not a request.
Allow at least `maxCallSeconds` for in-flight calls to finish; `tini` in the
image forwards SIGTERM correctly.

**The notification sweeper runs on every instance.** That is safe — delivery is
idempotent per notification row, and a `sent` row is never re-sent — but N
instances means N pollers. At any realistic volume this is noise; if it ever
matters, run the sweep on a single scheduled worker instead.

---

## Backups

`leads` and `callback_requests` are the business's revenue. `calls`,
`transcripts` and `call_events` are the audit trail that makes a disputed lead
resolvable.

Point-in-time recovery on Postgres, tested by actually restoring. Nothing here
is cached elsewhere; a lost lead is a lost customer.

---

## Monitoring

The signals worth alerting on, in order:

1. **`notifications` stuck `pending` or `failed`** for more than a few minutes.
   This is the product silently not working: leads are being captured and the
   operator does not know.
2. **`calls` with `outcome = 'error'`**, or stuck `in_progress` past
   `maxCallSeconds`.
3. **`GUARDRAIL_TRIPPED` events.** A rise means the model is trying to quote
   prices or promise arrival times. The guardrail is catching it, but the prompt
   or the model needs attention.
4. **`PROVIDER_ERROR` events**, which show which vendor is degrading.
5. `/health` returns `{"status":"degraded"}` when Postgres is unreachable.

```sql
-- Leads captured but not yet delivered
SELECT count(*) FROM notifications
WHERE status IN ('pending','failed') AND created_at < now() - interval '5 minutes';

-- Calls that ended badly today
SELECT outcome, count(*) FROM calls
WHERE started_at > now() - interval '1 day' GROUP BY outcome;
```

---

## Cost

Per completed call, roughly:

| | `gather` | `stream` |
|---|---|---|
| Twilio inbound | ~$0.01/min | ~$0.01/min + Media Streams |
| Speech recognition | included | Deepgram, ~$0.005/min |
| Synthesis | included | ElevenLabs, per character |
| Model | 2 calls/turn, ~6 turns | same |

The model runs at `effort: 'low'` on both calls: neither extracting fields from
one sentence nor phrasing a question the state machine already chose is hard
enough to repay deeper reasoning, and on a phone call a stranded caller notices
every extra 800ms. Model ids are environment variables, so a cheaper model is a
config change and no code change.

---

## Security checklist

- [ ] `DATABASE_URL` uses `towai_app`, **not** the owner
- [ ] `towai_app` password changed from the migration default
- [ ] JWT secrets generated, stored in a secret manager
- [ ] `TWILIO_VALIDATE_SIGNATURE=true`
- [ ] `ENABLE_DEV_SIMULATOR=false`
- [ ] TLS terminated in front of both services
- [ ] `PUBLIC_BASE_URL` matches the Twilio-facing URL exactly
- [ ] Postgres and Redis not reachable from the internet
- [ ] Backups running and a restore actually tested

The tenant-isolation and notification-reliability e2e suites are worth running
against a staging database after any change to the schema or its policies:

```bash
npm run test:e2e --workspace @towai/api
```
