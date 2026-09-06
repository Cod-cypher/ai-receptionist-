# Local development

## Prerequisites

- Node 20 or newer
- Docker (for Postgres and Redis)
- No API keys. The defaults run the entire pipeline offline.

## First run

```bash
cp .env.example .env
docker compose up -d postgres redis
npm install
npm run build --workspace @towai/shared
```

The shared package must be built before the API: the API resolves
`@towai/shared` through the workspace link to its **compiled output**, not its
source. Forgetting this produces `Cannot find module '@towai/shared'`.

Postgres is published on **5433**, not 5432, so it does not collide with a
Postgres installed on the host.

### Migrations

```bash
DATABASE_MIGRATION_URL="postgres://postgres:postgres@localhost:5433/towai" \
  npm run migrate --workspace @towai/api
```

Two connection strings exist and they are **not** interchangeable:

| Variable | Role | Used by |
|---|---|---|
| `DATABASE_MIGRATION_URL` | table owner (`postgres`) | migrations only |
| `DATABASE_URL` | `towai_app`, not the owner | the application |

Postgres lets table owners bypass row-level security. Pointing `DATABASE_URL` at
the owner would silently disable every tenant-isolation policy and everything
would appear to work — which is exactly why the two are separate. The migration
creates the `towai_app` role itself.

### Seed

```bash
DATABASE_MIGRATION_URL="postgres://postgres:postgres@localhost:5433/towai" \
  npm run seed --workspace @towai/api
```

Creates **two** towing companies on purpose, so tenant isolation is something
you can check by hand rather than only in a test.

```
Liberty Towing   +924235000001   owner@libertytowing.test
Rapid Recovery   +924235000002   owner@rapidrecovery.test
password: demo-password-1234
```

### Run

```bash
npm run build --workspace @towai/api && node apps/api/dist/main.js
npm run dev:dashboard    # separate terminal → http://localhost:4200
```

> **Use the compiled build, not `tsx`.** NestJS resolves constructor
> dependencies from `design:paramtypes` metadata, which `tsc` emits and esbuild
> (what `tsx` uses) does not. Running `tsx src/main.ts` fails with
> *"Nest can't resolve dependencies … argument at index [0] is undefined"*.
> `npm run start:dev --workspace @towai/api` uses `nest start --watch`, which is
> correct for iterating.

Swagger is at <http://localhost:3000/api/docs> outside production.

---

## Driving a call without a phone

The simulator runs the identical path a phone call takes — same engine, same
state machine, same persistence, same notification. Only the transport differs.

```bash
# 1. The call arrives on Liberty Towing's number
curl -s -X POST localhost:3000/api/dev/conversations \
  -H 'Content-Type: application/json' \
  -d '{"toNumber":"+924235000001","fromNumber":"+923001234567"}'
# → {"callId":"…","reply":"Thanks for calling Liberty Towing. How can I help?", …}

# 2. Each caller turn (businessId is in the seed output)
curl -s -X POST localhost:3000/api/dev/conversations/turn \
  -H 'Content-Type: application/json' \
  -d '{"businessId":"<id>","callId":"<callId>","text":"My car broke down near Liberty Market"}'
```

A full script that reaches a lead:

```
My car broke down near Liberty Market
It's a Toyota Corolla
It can't move
Ahmed
Yes
Yes that's right
```

You can also simulate non-speech events:

```bash
curl -X POST localhost:3000/api/dev/conversations/event \
  -H 'Content-Type: application/json' \
  -d '{"businessId":"<id>","callId":"<callId>","event":"HANGUP"}'
```

`SILENCE`, `HANGUP` and `MAX_DURATION` are accepted. Hanging up mid-intake is
worth trying: if every required field was already collected the lead is still
created, and if only some were, a callback request is raised instead.

### What to check afterwards

```sql
SELECT customer_name, service, location, vehicle_make, vehicle_movable, status FROM leads;
SELECT status, outcome, final_state, duration_seconds FROM calls;
SELECT channel, target, status, attempts FROM notifications;
SELECT sequence, type FROM call_events ORDER BY sequence;
```

`destination` and `additional_notes` should be **NULL**, not a placeholder
string — the receptionist does not store what the caller never said.

With `WHATSAPP_PROVIDER=console` the rendered notification is printed to the API
log, exercising the identical formatting path the real provider uses.

The simulator is gated behind `ENABLE_DEV_SIMULATOR` and the config schema
refuses to boot with it enabled under `NODE_ENV=production`. It is
unauthenticated.

---

## Tests

```bash
npm test                                   # 59 tests, no services required
npm run test:e2e --workspace @towai/api    # 14 tests, needs Postgres on 5433
```

The e2e suite creates and drops its own `towai_test` database on every run. It
leaves the database in place afterwards: when a test fails, being able to inspect
the rows it left behind is worth more than a clean server.

The e2e config compiles with SWC rather than esbuild, for the decorator-metadata
reason above.

---

## Switching to real providers

Everything below is optional; the defaults work without any of it.

```bash
AI_PROVIDER=anthropic          # or openai
ANTHROPIC_API_KEY=sk-ant-…
```

The stub does keyword matching, not language understanding. It is fine for
seeing the pipeline work and it makes the tests deterministic, but a real call
needs a real model — the stub will mis-hear anything phrased unusually.

For Twilio and WhatsApp, see [telephony-setup.md](telephony-setup.md) and
[whatsapp-setup.md](whatsapp-setup.md).

---

## Troubleshooting

**`Cannot find module '@towai/shared'`** — build the shared package first.

**`Nest can't resolve dependencies … index [0] is undefined`** — running through
`tsx` or plain esbuild. Use the `tsc` build.

**`invalid input syntax for type uuid: ""`** — a row-level security policy
missing its `nullif` wrapper. See migration `0003` and the note in
[architecture.md](architecture.md).

**Login returns 401 for a seeded user** — the API is running a build from before
the auth policies existed. Rebuild.

**`new row violates row-level security policy`** — either the app is connected
as the owner (so policies were never active and something else is wrong), or an
operation is running outside `withTenant` without one of the named escape
hatches. Note that `INSERT … RETURNING` also needs a SELECT policy, and Postgres
reports that as a misleading WITH CHECK violation.

**Postgres container exits immediately** — `postgres:18` wants its volume at
`/var/lib/postgresql`, not `/var/lib/postgresql/data`. Already handled in
`docker-compose.yml`; only relevant if you change it.

**Two copies of rxjs** — Angular's toolchain pins rxjs exactly, so a caret range
leaves a nested copy and its `Observable` type stops assigning to the hoisted
one. Both workspaces pin `7.8.1` exactly.
