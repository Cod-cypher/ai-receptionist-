# Architecture

## The problem this shape solves

A towing receptionist is a high-trust, low-autonomy job. The caller is stranded
and stressed, and every sentence the receptionist says is a commitment the
business has to honour. "We'll be there in twenty minutes" costs the operator a
complaint when the truck takes an hour. "That'll be three thousand" costs them
margin. "I've sent someone" costs them a customer standing at the roadside
waiting for a truck nobody dispatched.

A language model asked to be helpful will say all three. So the architecture's
central question is not "how do we make the AI good at this" but "how do we make
those sentences structurally impossible".

## The split

```
                    ┌──────────────────┐
                    │   Web Dashboard  │  Angular
                    └────────┬─────────┘
                             │  JWT, tenant-scoped
                    ┌────────▼─────────┐
                    │       API        │  NestJS
                    └────────┬─────────┘
                             │
        ┌────────────────────┼─────────────────────┐
        ▼                    ▼                     ▼
  Business config       Leads / Calls        Notifications
        │                                          │
        ▼                                          ▼
┌───────────────────┐                     ┌────────────────┐
│ ConversationEngine│                     │ WhatsAppProvider│
└─────────┬─────────┘                     └────────────────┘
          │
   ┌──────┴───────┐
   ▼              ▼
StateMachine   AiProvider          ← understands + phrases, decides nothing
   │              │
   │         ┌────┴────┬─────────┐
   │      Anthropic  OpenAI    Stub
   ▼
Guardrails                        ← last check before anything is spoken
   │
   ▼
TelephonyProvider  →  Twilio  →  Customer
```

Read that diagram for what is *missing*: there is no arrow from `AiProvider`
back into `StateMachine`, and none from `AiProvider` to anything that writes.

## Where each decision lives

| Decision | Made by | Why not the model |
|---|---|---|
| Which fields to collect | `slots.ts` data table | Changing intake should be a data edit, not a prompt rewrite |
| Which question comes next | `state-machine.ts` | Must be deterministic and testable |
| Whether an answer counted | `SlotDef.validate` | A model that invents `"unknown"` as a location must not fill the slot |
| When intake is complete | `isIntakeComplete` | A half-lead is worse than no lead |
| When to create a lead | `Effect: CREATE_LEAD` | Writes are never model-triggered |
| When to raise a callback | `state-machine.ts` | The fallback must be reachable when the model is the thing failing |
| What may be said aloud | `guardrails.ts` | Defence in depth: assume the prompt can be beaten |

## One turn

```
caller speech
   │
   ▼
AiProvider.understand()        structured observations only — no reply text,
   │                           no action field, no next-question field
   ▼
validateSlots()                invalid values discarded, not stored
   │
   ▼
reduce(context, input)         pure function → next state, one directive,
   │                           a list of effects
   ▼
AiProvider.generateResponse()  receives the directive; chooses words only
   │
   ▼
guardrails.checkReply()        price / ETA / dispatch / self-reference
   │                           → falls back to a deterministic template
   ▼
spoken, and effects executed
```

Two model calls per turn rather than one. That costs a few hundred milliseconds,
and buys the property that the workflow engine — not the model — provably picks
the next question. The reply is streamed to speech synthesis, so the caller does
not hear the difference.

### Why the state machine derives its state

The states are named (`COLLECT_LOCATION`, `COLLECT_VEHICLE`, …) so a call reads
clearly in the dashboard. But *which* state applies is re-derived every turn from
the first unfilled required slot:

```ts
nextUnsatisfiedRequirement(values)   // → the question to ask
```

This is why a caller who says *"I'm at Liberty Market, it's a Honda Civic and it
won't start"* skips three states without any special handling, and why a caller
who corrects themselves five turns later simply moves the machine backwards.
There is no cursor to get out of step with the data.

## Tenant isolation, three deep

Every table carries `business_id`, and three independent things have to fail
before one towing company sees another's callers:

1. **The token.** `businessId` is a signed claim. No endpoint accepts a business
   id as a parameter, so there is no request shape in which to ask for another
   tenant's data.
2. **The query.** Every repository method takes `businessId` as a required first
   argument.
3. **The database.** Row-level security policies on all 13 tenant tables. The
   application connects as `towai_app`, which is *not* the table owner — owners
   bypass RLS, so running as the owner would silently disable every policy.

Layer 3 is the one that matters, because it is the only one that holds when a
developer forgets layers 1 and 2. `tenant-isolation.e2e.test.ts` proves it
against a real database.

### The deliberate escape hatches

Three operations legitimately run before a tenant is known. Each gets its own
narrow policy and its own named method, rather than a general bypass:

| Method | Policy grants | Why it must exist |
|---|---|---|
| `withRoutingLookup` | SELECT on `phone_numbers` | An inbound call carries only a dialled number |
| `withAuthLookup` | SELECT on `users`, SELECT/UPDATE on `refresh_tokens` | A login form submits an email, not a business id |
| `withSignup` | INSERT on `businesses` | The tenant is what is being created |
| `withNotificationSweep` | SELECT on `notifications` | The retry sweeper serves every tenant at once |

None of them can reach a lead, a call, or a transcript.

> **A trap worth knowing.** `current_setting('app.business_id', true)` returns
> NULL only while the setting has never been defined on that connection. After
> the first transaction sets it, it reverts to the *empty string*, and `''::uuid`
> raises instead of matching no rows. On a pooled connection that turns the
> escape hatches into hard errors. Every policy therefore wraps the lookup in
> `nullif(…, '')`. See migration `0003`.

## Never losing a lead

The ordering is the entire guarantee:

```
BEGIN
  INSERT lead
  INSERT notification (status = 'pending')
COMMIT                              ← the lead is durable here
  ↓
attempt WhatsApp delivery           ← everything past this point is best-effort
  success → status = 'sent'
  failure → status = 'failed', attempts++, backoff 5s / 30s / 2m / 10m / 1h
  exhausted → status = 'dead', surfaced in the dashboard with a Resend button
```

The `notifications` table *is* the queue, rather than Redis or BullMQ. The row
has to exist anyway — the dashboard shows delivery state — and a second store
means two writes that can disagree: a job in Redis whose row says `pending`, or a
row marked `sent` for a job that never ran. One source of truth, survives a
restart, and a sweeper picks up anything orphaned by a crash between the commit
and the send.

Permanent failures (an invalid number) are not retried. Hammering them only
delays the operator noticing they need to fix their configuration.

## Provider interfaces

```ts
interface AiProvider {
  understand(input): Promise<ExtractionResult>;   // observations only
  generateResponse(input): Promise<string>;       // words only
  streamResponse?(input): AsyncIterable<string>;  // for speech synthesis
}

interface WhatsAppProvider {
  send(message: WhatsAppMessage): Promise<WhatsAppSendResult>;
}
```

Both AI adapters send the *same* hand-written JSON Schema
(`EXTRACTION_JSON_SCHEMA`) rather than each generating one from Zod. The two
vendor SDKs disagree about which major version of Zod their schema helpers take,
and pinning the monorepo to one vendor's preference is a worse trade than
maintaining one schema by hand. Zod then validates whatever comes back, so a
provider that ignores the schema is caught rather than trusted.

## The hallucination barrier

`formatLeadNotification(lead, ctx)` is a pure function of a **persisted** lead.
It never sees a transcript, a prompt, or model output. Whatever the model may
have invented during the call, only values that survived slot validation and a
database write can reach the operator's phone.

It is snapshot-tested, including a case that asserts every line of the message is
traceable to a validated column.

## Voice pipelines

Both drive the same `CallSessionService`; the conversation engine cannot tell
which is in use.

**`VOICE_PIPELINE=gather`** — TwiML `<Gather input="speech">`. Twilio does
speech recognition and synthesis. Needs only Twilio credentials, ~2–3s per turn,
coarse barge-in. This is what makes a real end-to-end call possible with two
credentials.

**`VOICE_PIPELINE=stream`** — Twilio Media Streams over WebSocket, Deepgram for
recognition, ElevenLabs for synthesis. True interruption: an interim transcript
arriving while speech is playing aborts the model stream, cancels synthesis, and
sends Twilio a `clear` to flush its buffer. See
[telephony-setup.md](telephony-setup.md).

**`VOICE_PIPELINE=chatgpt`** — Twilio Media Streams with one continuous
`gpt-realtime-mini` session acting as the receptionist. The model runs the
conversation; the backend is reached only through tools bound to the call
(`realtime-tools.ts`), which call `CallSessionService.applyIntakeOperation` →
the pure operations in `conversation/intake.ts` → the same slot validation,
merge and `finish()` the state machine uses → `commitTurn`. `reduce()` itself is
unchanged and still drives `gather` and `stream`. The gateway tracks playback
with Twilio marks, truncates the model's memory on barge-in, checks the model's
speech against the guardrails as it is produced, and writes the transcript in
speaking order.

## Traceability

Every decision emits a `call_events` row with a monotonic sequence number:

```
CALL_STARTED → AI_GREETING → CUSTOMER_SPEECH → FIELD_EXTRACTED ×4
→ STATE_CHANGED → … → LEAD_CREATED → WHATSAPP_QUEUED → CALL_ENDED
```

Debugging a production call means reading that list, which is why the engine
emits an event for every field it accepted *and* every one it rejected, with the
reason. The dashboard's call detail page renders it alongside the transcript.
