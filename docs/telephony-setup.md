# Telephony setup

## The flow being built

```
Customer dials the towing company's usual number
        ↓
It rings the office
        ↓
Nobody answers (busy, or after N rings)
        ↓
The carrier forwards the call to a Twilio number
        ↓
Twilio POSTs this API, and the receptionist answers
```

The towing company keeps the number printed on their trucks. Nothing about
their existing line changes except a forwarding rule.

---

## Quick path: your first real call

With a Twilio account and a voice number already bought:

1. Install a tunnel once: `winget install --id Cloudflare.cloudflared`
2. Put `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` in `.env`.
3. `npm run dev`
4. Phone your Twilio number.

`npm run dev` opens the tunnel, writes its address to `.env` as
`PUBLIC_BASE_URL`, starts the API with that address already in its environment,
and then runs `twilio:connect` — which checks the tunnel reaches this API,
routes the number to the demo company, and points its webhooks here. Because
the free tunnel address changes on every restart, this is also what you re-run
after stopping it; nothing needs editing by hand. Pass `--dry-run` to see the
Twilio changes without making them, or `--number +1…` to choose between several
numbers on the account.

### Or by hand

```bash
cloudflared tunnel --url http://localhost:3000   # terminal 1, copy the https URL
                                                 # put it in .env as PUBLIC_BASE_URL
npm run start:api                                # terminal 2 — after .env is saved
npm run twilio:connect                           # terminal 3
```

The API must be started *after* `PUBLIC_BASE_URL` is set, or it validates
Twilio's signatures against the old address and 403s every call.

The rest of this page explains each piece, and what to do for a real towing
company's line.

---

## 1. A Twilio number

Buy a voice-capable number in the Twilio console, in a region local to the
towing company. Then point its **A CALL COMES IN** webhook at:

```
POST  https://<your-domain>/api/telephony/twilio/voice
```

and its **CALL STATUS CHANGES** webhook at:

```
POST  https://<your-domain>/api/telephony/twilio/status
```

The status webhook is what turns a caller hanging up into a finalised call. Skip
it and a caller who gives every detail then hangs up before confirming leaves a
call stuck `in_progress` and no lead — which is precisely the case the product
exists to catch.

## 2. Attach the number to the business

The dialled number is the **only** thing identifying the tenant on an inbound
call. Until it is registered, calls to it are answered with an apology and
logged as an error.

Dashboard → **Settings → Phone numbers**, or:

```bash
curl -X POST https://<your-domain>/api/business/phone-numbers \
  -H "Authorization: Bearer <token>" \
  -H 'Content-Type: application/json' \
  -d '{"e164":"+924235000001"}'
```

## 3. Forward the office line

On the towing company's existing line, set **conditional** forwarding — on busy
and on no-answer — to the Twilio number. The codes vary by carrier; on most GSM
networks:

| Condition | Code |
|---|---|
| No answer | `**61*<twilio number>*11*20#` (20 = seconds before forwarding) |
| Busy | `**67*<twilio number>#` |
| Unreachable | `**62*<twilio number>#` |
| Cancel all | `##002#` |

Set the no-answer delay to **20–25 seconds**. Shorter and staff who were about
to pick up lose the call; longer and the customer has already dialled a
competitor.

Do not use unconditional forwarding. The receptionist is for missed calls; a
human answering is always the better outcome.

## 4. Expose the API during development

Twilio must reach your machine, and it signs requests against the URL it called,
so `PUBLIC_BASE_URL` has to match the public URL exactly.

```bash
cloudflared tunnel --url http://localhost:3000
# → https://something-random.trycloudflare.com
```

```bash
PUBLIC_BASE_URL=https://something-random.trycloudflare.com
```

A mismatch here shows up as `403 Invalid Twilio signature` on every webhook.

---

## Choosing a pipeline

```bash
VOICE_PIPELINE=gather   # or: stream, chatgpt
```

### `gather` — start here

TwiML `<Gather input="speech">`. Twilio does the speech recognition and speaks
the reply with `<Say>`.

- **Credentials:** Twilio only (plus a model key, or the stub).
- **Latency:** ~2–3s per turn.
- **Interruption:** `bargeIn="true"` lets the caller talk over the prompt, but
  Twilio still finishes its recognition window.

This is the fastest way to have a real phone call working, and it is a
legitimate production configuration for a company that mostly needs the details
captured.

### `stream` — the natural one

Twilio Media Streams over a WebSocket, Deepgram for recognition, ElevenLabs for
synthesis.

- **Credentials:** Twilio + Deepgram + ElevenLabs (plus a model key).
- **Latency:** ~1–1.5s per turn, and the caller hears the first syllable much
  sooner because synthesis is streamed.
- **Interruption:** real. Speech onset aborts the model call, abandons synthesis
  mid-sentence, and sends Twilio a `clear` to flush audio it has already
  buffered.

```bash
VOICE_PIPELINE=stream
DEEPGRAM_API_KEY=...
DEEPGRAM_MODEL=nova-3
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...        # from the ElevenLabs voice library
```

The WebSocket endpoint is `/api/telephony/twilio/media`. If you terminate TLS at
a proxy, it must forward `Upgrade` and `Connection` headers — the bundled
`nginx.conf` already does.

### `chatgpt` - a conversational receptionist with a deterministic brain

Twilio Media Streams over a WebSocket, with one continuous `gpt-realtime-mini`
session per call. The model holds the conversation: it answers what the
caller means ("Hello?", "Can you hear me?", "I'm really stressed" get a natural
reply) and phrases every question. The backend decides everything that can be
decided in code:

- **What to ask next.** When the caller finishes a turn, the gateway asks the
  backend's priority engine (`conversation/next-action.ts`) for the one
  REQUIRED ACTION and pins it to the conversation as a short note, then asks
  for the reply. The order is the business's intake order, with safety advice
  first, then anything the model was unsure it heard, and a vague location
  narrowed down before anything lower.
- **Whether a location is precise enough** (`conversation/location.ts`): "I-95"
  or "downtown" is saved but asked about again (nearest exit, mile marker,
  cross street, landmark), at most twice.
- **Whether a confirmation happened.** A "yes" to the callback number or the
  read-back only counts if the caller has spoken since the question was asked.
  The caller-turn counter comes from the audio, so the model cannot confirm on
  the caller's behalf.
- **Urgency and safety** (`conversation/risk.ts`): a highway breakdown, an
  accident, or "I need it immediately" makes the lead URGENT, and a hazard
  makes the receptionist give emergency advice first, using the caller's own
  country's number (911 for +1 callers).
- **Provenance.** Details the model filled in itself ("Ford" from "Mustang") or
  was unsure of are tagged on the lead, and restatements never downgrade a
  saved detail ("truck" after "semi truck").

What the model says is checked as it speaks. A reply that claims a price,
arrival time, dispatch or availability, or that asks about something the
priority engine said must wait, is stopped before the caller hears it and the
model redirected (once per turn). These are recorded as `GUARDRAIL_TRIPPED`,
`ACTION_DEVIATION` and `CONFIRMATION_REJECTED` call events; each call also
records its token usage, and how long callers waited for each reply, as
`AI_USAGE`.

**Interruptions.** When the caller starts talking over the receptionist,
playback stops at once (Twilio's buffer is cleared) but the reply is not
given up yet. The gateway measures the caller's audio: if they keep talking
for well over half a second it is a real interruption — the response is
cancelled, the model's memory of the reply is truncated to what was heard,
and the caller's words are answered as a new turn. If they said a word or two
("okay", "uh-huh", "yeah") or it was a burst of road noise, the receptionist
pauses for a moment and then carries on from where the caller stopped
hearing, and the acknowledgement gets no reply of its own. Before this, every
"uh-huh" restarted the reply from the beginning, which callers heard as the
receptionist repeating itself. An `AI_INTERRUPTED` event is recorded only for
real interruptions.

**Tool calls.** Saving a detail takes two model round trips. The model may say
a word or two ("Okay.") in the same breath as the tool call, but is not asked
to say more: on gpt-realtime-mini, asking for an acknowledgement made it talk
instead of saving. The note that returns with the tool result tells it what it
already said, so the reply carries on from there; the fillers below cover the
wait.

**Fixed lines.** The read-back is spoken word for word from the backend's
summary, with the callback number digit by digit, because it is the caller's
one chance to catch a mishearing before the lead is sent. The silence check is
a fixed "Are you still there?". Neither is left to the model to phrase.

**Fillers.** If a reply still has not reached the caller about a second after
their turn, the gateway plays a short line in the receptionist's own voice
("Mm-hm.", "One moment."), the way a person fills a pause while writing
something down. The lines are synthesised once at start-up by a short-lived
realtime session, so they match the call voice exactly; if that fails, calls
run without them. Fillers appear in the transcript like any other line.

| Tool | Backend behaviour |
|---|---|
| `update_call_information` | Validates each field; never erases or downgrades; tags inferred/unsure fields |
| `get_call_state` | What is saved, what is missing, and the required action |
| `get_business_information` | Answers only from configuration; anything else raises one callback |
| `complete_request` | Returns the read-back; creates the lead only after the caller confirms it |
| `request_callback` | Raises a callback (once per call) |
| `end_call` | Finalises like a hang-up: a lead if complete, otherwise a callback |

```bash
VOICE_PIPELINE=chatgpt
OPENAI_API_KEY=...
AI_REALTIME_MODEL=gpt-realtime-mini
AI_REALTIME_VOICE=marin
AI_REALTIME_SILENCE_MS=900
AI_REALTIME_TURN_DETECTION=server_vad     # or semantic_vad
AI_REALTIME_VAD_EAGERNESS=auto            # semantic_vad: low | medium | high | auto
AI_REALTIME_NOISE_REDUCTION=near_field    # far_field for speakerphone callers, or off
AI_REALTIME_TRANSCRIPTION_MODEL=gpt-4o-transcribe
```

**Turn detection.** `server_vad` ends the caller's turn after
`AI_REALTIME_SILENCE_MS` of quiet: predictable, and 900 ms suits callers who
pause to work out where they are. `semantic_vad` also has OpenAI judge from
the words whether the caller has finished, so "it's near… um" waits and a
clear "yes" is answered sooner; `AI_REALTIME_VAD_EAGERNESS=low` waits longest.
Try it on a real call if callers are still being cut off, or replies feel
slow after short answers. Either way the receptionist never starts or cancels
a reply on its own; the gateway does both.

**Noise reduction** is applied by OpenAI before its voice activity detection.
`near_field` is right for a handset; a caller on speakerphone in a car is
`far_field`. Without it, road noise and breathing start caller turns and
interrupt the receptionist.

**Rate limits.** New OpenAI accounts are limited to 40,000 tokens per minute on
gpt-realtime-mini. A call uses a few thousand tokens per minute, so more than
two or three simultaneous calls can hit the limit, and OpenAI then ends the
session mid-call (the call is finalised as a lead or callback and a
`PROVIDER_ERROR` event is recorded). The limit rises with account usage tier.

Reliability benchmark (real sessions, simulated caller; costs cents per run):

```bash
npm run realtime:check                              # two scenarios, once each
npm run realtime:eval -- --label after --verbose    # 30 runs targeted, 5 the rest
```

Besides the intake checks, every run is scored for repetition (a sentence
said twice in a call, `REPEATED_REPLY`) and for asking about two things in
one turn (`MULTIPLE_QUESTIONS`), and the report ends with the reply latency:
how long after the caller's turn ends the first audio of the reply is
produced. The bar to compare against is a hosted conversational agent such as
ElevenLabs, at roughly one second.

The WebSocket endpoint is `/api/telephony/twilio/realtime`. The transcript
records the caller's words (transcribed separately) and every word the
receptionist said. A reply that was cut off keeps all its words and is marked
`[interrupted]` (the caller spoke over it), `[stopped]` (a guardrail or the
required action stopped it) or `[call ended]`. Audio reaches the caller ahead
of the playback marks that measure it, so how much was heard is only an
estimate; it is in the event trail (`AI_INTERRUPTED`, `ACTION_DEVIATION`,
`GUARDRAIL_TRIPPED`, field `heard`). A caller line missing from the
transcript has a `TRANSCRIPT_DROPPED` event saying why: echo, a failed or late
transcription, or the call ending first.

All pipelines drive the same `CallSessionService`. Switching between them
changes no workflow, no database write and no lead.

---

## Choosing a voice

For `gather`, `TWILIO_TTS_VOICE` takes any Amazon Polly or Google voice Twilio
supports (`Polly.Joanna`, `Polly.Aditi`, …).

For `stream`, set a per-business voice under **Settings**, falling back to
`ELEVENLABS_VOICE_ID`. Pick something calm and unhurried. Callers are often
stranded at the roadside, sometimes in an unsafe spot; a brisk, chirpy voice
reads as indifference.

---

## Verifying

1. Call the Twilio number directly first, before touching any forwarding. You
   should hear the configured greeting.
2. Say *"my car broke down near the main market"* and follow the questions.
3. Check the dashboard: the call appears with its transcript and event trail,
   and a lead is created once you confirm the summary.
4. Now set forwarding on the office line and call **that** number, letting it
   ring out.

### When it does not work

| Symptom | Cause |
|---|---|
| `403 Invalid Twilio signature` | `PUBLIC_BASE_URL` does not match the URL Twilio called. Tunnel URLs change on restart. |
| *"this number isn't set up to take calls"* | The dialled number is not registered against a business. |
| Silence after answering, on `chatgpt` | `OPENAI_API_KEY` missing or without realtime access — run `npm run realtime:check`. |
| Silence after answering, on `stream` | Deepgram or ElevenLabs credentials missing, or a proxy not forwarding `Upgrade`. |
| Call connects then drops immediately | Check the API log — a failed `startCall` returns an apology and hangs up rather than leaving the caller in silence. |
| Calls stuck `in_progress` | The status callback is not configured. |

Every call writes a full event trail, so the call detail page usually answers
"what happened" faster than the logs do.
