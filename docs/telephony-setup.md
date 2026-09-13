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
3. Terminal 1: `cloudflared tunnel --url http://localhost:3000` — copy the
   `https://….trycloudflare.com` address it prints.
4. Set `PUBLIC_BASE_URL` in `.env` to that address.
5. Terminal 2: `npm run start:api`
6. Terminal 3: `npm run twilio:connect` — checks the tunnel reaches this API,
   routes the number to the demo company, and points its webhooks here.
   Add `-- --dry-run` first if you want to see the changes before they happen.
7. Phone your Twilio number.

Steps 3–6 repeat whenever cloudflared restarts, because the address changes.
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
VOICE_PIPELINE=gather   # or: stream
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

Both pipelines drive the same `CallSessionService`. Switching between them
changes no conversation behaviour, no database write and no lead.

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
| Silence after answering, on `stream` | Deepgram or ElevenLabs credentials missing, or a proxy not forwarding `Upgrade`. |
| Call connects then drops immediately | Check the API log — a failed `startCall` returns an apology and hangs up rather than leaving the caller in silence. |
| Calls stuck `in_progress` | The status callback is not configured. |

Every call writes a full event trail, so the call detail page usually answers
"what happened" faster than the logs do.
