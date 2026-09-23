# AI Towing Receptionist

**Never miss a towing lead again.**

When a towing company's phone goes unanswered, the call forwards here. The
receptionist answers, collects the towing details through a fixed workflow,
saves a structured lead, and pushes it to the company's WhatsApp — usually
before the caller has finished parking their hazard lights.

```
Customer calls  →  nobody answers  →  forwarded here
        ↓
AI answers, collects details, confirms them
        ↓
Lead saved in Postgres  →  WhatsApp to the tow operator
        ↓
"The towing team will contact you shortly."
```

---

## The one design decision that matters

**The language model does not run the conversation.** A deterministic state
machine decides which question comes next, whether an answer counted, when the
intake is complete, and when a lead is created. The model does two narrow jobs:
work out what the caller just said, and phrase the question the state machine
has already chosen.

That split is enforced by the shape of the code, not by prompt instructions:

| Concern | Owner |
|---|---|
| What to collect, and in what order | [`packages/shared/src/domain/slots.ts`](packages/shared/src/domain/slots.ts) |
| Next question, validity, completion, lead creation | [`apps/api/src/conversation/state-machine.ts`](apps/api/src/conversation/state-machine.ts) |
| Understanding speech | `AiProvider.understand()` — returns observations only |
| Choosing words | `AiProvider.generateResponse()` — receives an already-decided directive |
| What may be said aloud | [`apps/api/src/conversation/guardrails.ts`](apps/api/src/conversation/guardrails.ts) |

The extraction call has no field through which the model could propose an
action, and the generation call receives exactly one directive. A model that
wanted to dispatch a truck has nowhere to say so.

On top of that, every generated reply passes a guardrail filter that blocks
invented prices, arrival-time promises, dispatch claims and AI self-reference,
falling back to a deterministic template. The receptionist is a receptionist,
not a dispatcher.

---

## What is built

- **Conversation engine** — slot model, state machine, guardrails, prompt
  assembly. Pure functions, no framework, no I/O.
- **Multi-tenant data layer** — Postgres with row-level security on every
  tenant table, verified by integration tests.
- **Telephony** — Twilio inbound voice with signature validation and tenant
  routing by dialled number, behind a swappable interface.
- **WhatsApp** — lead notifications rendered from the persisted lead, with
  retries and a delivery log.
- **Auth** — argon2, tenant-scoped JWTs, rotating refresh tokens.
- **Dashboard** — Angular: overview, leads, calls with transcripts and the full
  decision trail, callbacks, settings.
- **Two AI vendors** — Anthropic and OpenAI behind one interface, plus a
  deterministic stub so the whole pipeline runs with no API key at all.
- **Typed judgments** — optionally, TypeSafe's Jev model judges the two things
  regex rules got wrong on real calls: whether a location is precise enough to
  dispatch to, and whether the caller is in danger. It returns a typed answer
  with a confidence, never words, and the order of the call stays in code.
  Without a key, the rules decide alone. See
  [`typesafe-questions.ts`](apps/api/src/integrations/judgment/typesafe-questions.ts).

---

## Quick start

Requires Docker Desktop and Node 20+. Works the same in PowerShell and bash.
No API keys needed.

**Once:**

```
copy .env.example .env        # bash: cp .env.example .env
npm install
```

**Each time — one command:**

```
npm run dev
```

With Docker Desktop already running, that brings up Postgres and
Redis, creates the schema and the demo companies on a fresh database, opens a
cloudflared tunnel and writes its URL to `.env` as `PUBLIC_BASE_URL`, starts the
API on :3000 with that URL, points your Twilio number's webhooks at it (when
Twilio credentials are set), and serves the dashboard on :4200. Ctrl+C stops all
of it. `npm run dev:local` skips the tunnel and Twilio.

Then, to phone the receptionist from your keyboard:

```
npm run simulate:call         # second terminal
```

There you play the caller. Try:

```
You: my car broke down near Liberty Market
You: its a Honda Civic
You: it cant move
You: Bilal
You: yes
You: yes thats right
```

When the call ends it prints the saved lead and the exact WhatsApp message the
tow operator would receive. The call then appears in the dashboard — sign in as
`owner@libertytowing.test` / `demo-password-1234` and open **Calls** to see the
transcript alongside every decision the receptionist made.

Commands while calling: `/silence`, `/hangup`, `/quit`. More scenarios worth
trying are in [docs/local-development.md](docs/local-development.md).

> The default `.env` uses `AI_PROVIDER=stub` and `WHATSAPP_PROVIDER=console`.
> The stub does keyword matching, not language understanding — enough to see the
> pipeline work, and it will mis-hear anything phrased unusually. Set
> `AI_PROVIDER=anthropic` (or OpenRouter, see `.env.example`) to test real
> conversation quality.

The simulator drives the identical path a phone call takes — same engine, same
state machine, same database writes, same notification. Only the transport
differs.

---

## Documentation

| | |
|---|---|
| [Architecture](docs/architecture.md) | How the pieces fit, and why the workflow is server-side |
| [Local development](docs/local-development.md) | Running it, the simulator, tests, troubleshooting |
| [Telephony setup](docs/telephony-setup.md) | Twilio numbers, call forwarding, both voice pipelines |
| [WhatsApp setup](docs/whatsapp-setup.md) | Sandbox vs approved templates |
| [Deployment](docs/deployment.md) | Production configuration and the things that will bite |
| [API](docs/api.md) | Endpoint reference; Swagger at `/api/docs` in development |

---

## Tests

```
npm test           # 69 tests, no services needed
npm run test:e2e   # 14 tests against a real Postgres (docker compose up first)
```

The unit tests cover the conversation: the specification's worked dialogue, one
utterance filling three slots, a caller correcting themselves, FAQ answers drawn
only from configured data, escalation, silence, hang-ups mid-intake, provider
failure, and a model that tries to quote a price.

The integration tests cover the two promises that matter commercially:

- **Two towing companies cannot see each other's callers.** Enforced in three
  places — the token's claim, an explicit filter on every query, and a Postgres
  row-level security policy. The last is the one that holds when a developer
  forgets the first two.
- **A WhatsApp outage costs a notification, never a lead.** The lead and its
  pending notification commit in a single transaction *before* any network call.

---

## Repository layout

```
packages/shared/         slot model, states, lead schema, notification formatter
apps/api/
  conversation/          the state machine and guardrails — pure, no framework
  integrations/          ai/ telephony/ whatsapp/ — one interface, several vendors
  call-session/          executes the engine's effects against the database
  database/              schema, migrations (RLS lives here), seed
  modules/               auth, businesses, calls, leads, callbacks, notifications
apps/dashboard/          Angular
docs/
```

---

## Deliberately not built

No CRM, no dispatch, no driver assignment, no payments, no scheduling, no
outbound calling, no analytics beyond the four overview counters. The provider
interfaces and the channel-agnostic engine are the only concessions to a future
roadmap; there are no placeholder modules for features that do not exist.
