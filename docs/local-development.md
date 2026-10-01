# Local development

## Prerequisites

- Node 20 or newer
- Docker (for Postgres and Redis)
- No API keys. The defaults run the entire pipeline offline.

## First run

```bash
cp .env.example .env
npm install
npm run dev
```

`npm run dev` ([scripts/dev.mjs](../scripts/dev.mjs)) does everything below in
one terminal — Docker, migrations and seed on an empty database, the tunnel,
the API, `twilio:connect`, the dashboard — and stops all of it on Ctrl+C. The
rest of this page is what it runs, for when one piece needs doing by hand.

| Flag | Effect |
|---|---|
| `--no-tunnel` | no cloudflared; `PUBLIC_BASE_URL` is left alone |
| `--no-twilio` | do not touch the Twilio number's webhooks |
| `--no-dashboard` | API only |
| `--no-docker` | use a Postgres and Redis you started yourself |
| `--start-docker` | also launch Docker Desktop and wait for its daemon |

Docker Desktop is not launched for you by default: it is the heaviest thing on
the machine, and a freeze while `npm run dev` was starting it looks exactly like
a freeze this project caused. Start it yourself, or pass `--start-docker`.

`npm run dev:local` is `--no-tunnel --no-twilio`, for working offline. Anything
else you pass (`--number`, `--business`, `--dry-run`) goes through to
`twilio:connect`.

### Doing it by hand

```bash
docker compose up -d postgres redis
npm run build --workspace @towai/shared
```

The shared package must be built before the API: the API resolves
`@towai/shared` through the workspace link to its **compiled output**, not its
source. Forgetting this produces `Cannot find module '@towai/shared'`.

Postgres is published on **5433**, not 5432, so it does not collide with a
Postgres installed on the host.

### Migrations

```
npm run migrate
```

`npm run setup` does this, the seed, and the shared-package build in one go.
Both scripts read the repository-root `.env`, so no variables need setting by
hand.

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

```
npm run seed
```

Safe to re-run: companies that already exist are skipped.

Creates **two** towing companies on purpose, so tenant isolation is something
you can check by hand rather than only in a test.

```
Liberty Towing   +924235000001   owner@libertytowing.test
Rapid Recovery   +924235000002   owner@rapidrecovery.test
password: demo-password-1234
```

### Run

```
npm run start:api        # builds, then runs the API on :3000
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

```
npm run simulate:call
```

You play the caller and type what you would say. It runs the identical path a
phone call takes — same engine, same state machine, same persistence, same
notification — with only the transport swapped. When the call ends it prints the
lead that was saved and the WhatsApp message the operator would get.

A script that reaches a lead:

```
my car broke down near Liberty Market
its a Honda Civic
it cant move
Bilal
yes
yes thats right
```

Commands mid-call: `/silence` (a no-input timeout), `/hangup`, `/quit` (leave
without hanging up). Ending input with Ctrl+Z (Windows) or Ctrl+D counts as the
caller hanging up.

Things worth trying beyond the happy path:

| Say | What should happen |
|---|---|
| everything in one sentence | several questions skipped |
| "sorry, it's actually a Toyota" | the earlier answer overwritten |
| "what areas do you cover?" | answered from the business's configured areas |
| "how much will it cost?" | pricing read from configuration, never invented |
| "how soon can you get here?" | "I can't confirm that", and a callback raised |
| "I want a refund" | escalated to a callback request |
| `/hangup` halfway through | a callback with the partial details |

To call the second demo company, or reach an API on another port (PowerShell):

```powershell
$env:SIM_TO_NUMBER = "+924235000002"
$env:API_URL = "http://127.0.0.1:3100"
npm run simulate:call
```

It accepts piped input too, for repeatable scripts:

```powershell
"my car broke down near Liberty Market`nits a Honda Civic`nno`nBilal`nyes`nyes" | npm run simulate:call
```

The endpoints behind it, for scripting directly: `POST /api/dev/conversations`,
`POST /api/dev/conversations/turn`, `POST /api/dev/conversations/event` and
`GET /api/dev/conversations/:callId?businessId=`.

### What to check afterwards

```sql
SELECT customer_name, service, location, vehicle_make, vehicle_movable, status FROM leads;
SELECT status, outcome, final_state, duration_seconds FROM calls;
SELECT channel, target, status, attempts FROM notifications;
SELECT sequence, type FROM call_events ORDER BY sequence;
```

`destination` and `additional_notes` should be **NULL**, not a placeholder
string — the receptionist does not store what the caller never said.

### Reading a call, decision by decision

```powershell
npm run call:trace -- latest
npm run call:trace -- <callId> --notes
npm run call:trace -- latest --only NEXT_ACTION,AI_RESPONSE,JUDGMENT
```

Prints one call from the database turn by turn: what the caller said, what
Jev made of it and how long it took (`JUDGMENT`), each tool call and what
the model was told back (`TOOL_CALL`), what was saved and where an inferred
value came from (`FIELD_EXTRACTED`), any urgency or hazard and what found it
(`RISK_ASSESSED`), what the receptionist had to do next and why
(`NEXT_ACTION`, deciding reason first), the note it was given (`MODEL_NOTE`;
`--notes` prints it in full), each reply asked for (`REPLY_REQUESTED`), and
every word it said (`AI_RESPONSE`), including a reply that was stopped, with
why and how much was heard. `--json` dumps the raw rows.

It reads with `DATABASE_MIGRATION_URL`, the table owner. With only
`DATABASE_URL`, row-level security hides every call until a business is
named: add `--business <uuid>`. Calls recorded before the trail existed
print their transcript and events interleaved by time.

With `WHATSAPP_PROVIDER=console` the rendered notification is printed to the API
log, exercising the identical formatting path the real provider uses.

The simulator is gated behind `ENABLE_DEV_SIMULATOR` and the config schema
refuses to boot with it enabled under `NODE_ENV=production`. It is
unauthenticated.

---

## Tests

```
npm test           # 69 tests, no services required
npm run test:e2e   # 14 tests, needs Postgres on 5433
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

### TypeSafe Jev: judging locations and danger

```bash
TYPESAFE_API_KEY=ts-…          # from https://typesafe.ai
TYPESAFE_MODEL=jev-latest
TYPESAFE_TIMEOUT_MS=1500
```

With a key, every location the receptionist saves and every line the caller
says goes to Jev in one request, which answers with typed judgments: a 0-2
precision score for the location, a hazard choice, and a probability that
the caller is asking for help urgently. `determineNextAction` uses them to
decide between "where exactly?" and moving on, and whether to give safety
advice first. While the caller is being asked to confirm the read-back or
the callback number, the same request also asks whether their line is a yes
or a correction, and the backend refuses the model's `complete_request` when
it was not a yes. Words said over the receptionist are judged as an answer
(reply to it) or an acknowledgement (say nothing). The regex rules and word
lists stay as the fallback: when the key is missing, the request times out,
or Jev is not confident, the call proceeds exactly as before.

The questions, their wording and the confidence thresholds live in one file,
[`typesafe-questions.ts`](../apps/api/src/integrations/judgment/typesafe-questions.ts),
meant to be edited by hand after looking at real judgments.
`npm run realtime:explain -- <scenario>` prints every judgment Jev made
during a run, and every decision in the same form as `call:trace`
(`--verbose` adds the notes given to the model).

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

**Dashboard login fails, or `simulate:call` cannot reach the API** — something
else on your machine may own port 3000. Stop it, or run the API elsewhere
(`$env:PORT = "3100"`), then set `API_URL` for the simulator and change the
target in `apps/dashboard/proxy.conf.json` to match.

**http://127.0.0.1:4200 does not load** — on Windows `ng serve` listens on
`localhost` over IPv6. Open http://localhost:4200.

**`[1, 1] InvalidSymbol` from the dashboard proxy** — the JSON file was saved with
a byte-order mark, which Windows PowerShell 5.1's `Set-Content -Encoding utf8`
adds. Re-save it as UTF-8 without a BOM.

**Two copies of rxjs** — Angular's toolchain pins rxjs exactly, so a caret range
leaves a nested copy and its `Observable` type stops assigning to the hoisted
one. Both workspaces pin `7.8.1` exactly.
