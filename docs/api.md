# API

Base path `/api`. Interactive docs at `/api/docs` outside production.

## Authentication

`Authorization: Bearer <accessToken>` on everything except `/health`, the auth
endpoints, and the Twilio webhooks (which authenticate by request signature).

**No endpoint accepts a business id.** Scope comes from the `businessId` claim in
the signed token, so there is no request a client could construct that reaches
another towing company's data. A resource belonging to another tenant returns
**404**, not 403 — a 403 would confirm the id exists.

Access tokens last 15 minutes. Refresh tokens are opaque, single-use, and stored
only as a hash; presenting one twice fails, because a second presentation means
it leaked.

---

## Auth

### `POST /api/auth/register`

Creates a towing company and its first owner, seeded with the nine standard
towing services. Rate limited to 5/hour.

```json
{
  "businessName": "Liberty Towing",
  "email": "owner@example.com",
  "password": "at least 12 characters",
  "name": "Owner name",
  "timezone": "Asia/Karachi"
}
```

→ `201` `{ accessToken, refreshToken, businessId, user }`

### `POST /api/auth/login`

Rate limited to 10 per 15 minutes. A wrong password and a non-existent account
take the same time to reject.

```json
{ "email": "owner@example.com", "password": "..." }
```

→ `200` `{ accessToken, refreshToken, businessId, user }`

### `POST /api/auth/refresh` → `200` `{ accessToken, refreshToken }`
### `POST /api/auth/logout` → `204`

Both take `{ "refreshToken": "..." }`.

---

## Dashboard

### `GET /api/dashboard/overview?days=30`

```json
{
  "since": "2026-02-13T00:00:00.000Z",
  "callsReceived": 42,
  "aiAnsweredCalls": 39,
  "leadsCaptured": 27,
  "openCallbackRequests": 3,
  "recentCalls": [...],
  "recentLeads": [...]
}
```

---

## Leads

### `GET /api/leads`

| Query | |
|---|---|
| `status` | `new` `contacted` `completed` `cancelled` |
| `search` | matches name, phone, location, vehicle make/model |
| `since` | ISO date |
| `limit` | 1–100, default 25 |
| `offset` | default 0 |

→ `{ items: Lead[], total, limit, offset }`

A `Lead`:

```json
{
  "id": "…",
  "businessId": "…",
  "callId": "…",
  "customerName": "Ahmed",
  "customerPhone": "+923001234567",
  "service": "Vehicle towing",
  "location": "Liberty Market",
  "destination": null,
  "vehicleMake": "Toyota",
  "vehicleModel": "Corolla",
  "vehicleType": null,
  "vehicleCondition": "broke down",
  "vehicleMovable": false,
  "additionalNotes": null,
  "source": "ai_receptionist",
  "status": "new",
  "createdAt": "2026-03-14T21:17:00.000Z"
}
```

`null` means the caller did not say. It is never a placeholder string, and
`vehicleMovable: null` ("not established") is deliberately distinct from
`false` ("cannot move").

### `GET /api/leads/:id` → the lead, or `404`
### `PATCH /api/leads/:id/status`

```json
{ "status": "contacted" }
```

Writes an audit log entry.

---

## Calls

### `GET /api/calls?outcome=&limit=&offset=`

`outcome` is one of `lead_created` `callback_created` `faq_answered`
`abandoned` `error`.

### `GET /api/calls/:id`

Everything needed to understand one call:

```json
{
  "call": { "fromNumber": "…", "outcome": "lead_created", "durationSeconds": 47, "finalState": "ENDED", … },
  "transcript": [ { "turnIndex": 0, "speaker": "ai", "text": "Thanks for calling…" }, … ],
  "events":     [ { "sequence": 0, "type": "CALL_STARTED", "payload": {…} }, … ],
  "lead": { … } | null,
  "callbackRequests": [ … ],
  "extractedInformation": { "location": "Liberty Market", "vehicleMovable": false, … }
}
```

`events` is the decision trail — every field accepted, every field rejected and
why, every state change, every guardrail trip. It is usually faster than the
logs for answering "why did it ask that?".

---

## Callbacks

### `GET /api/callbacks?status=open|resolved`
### `GET /api/callbacks/:id`

Includes `transcriptSnapshot`, frozen at creation so the record reads on its own.

### `PATCH /api/callbacks/:id/status` — `{ "status": "resolved" }`

---

## Notifications

### `GET /api/notifications?status=pending|sent|failed|dead`

Delivery state per lead or callback: `attempts`, `lastError`, `sentAt`,
`providerMessageId`, and the exact `payload` that was sent.

### `POST /api/notifications/:id/retry`

Resets the attempt counter and tries immediately. For a `dead` notification once
the operator has fixed whatever caused it.

→ `{ "status": "sent" | "failed" | "dead" }`

---

## Business configuration

### `GET /api/business`

→ `{ business, settings, services, phoneNumbers }`

### `PUT /api/business` *(owner, manager)*

`name` `phone` `website` `address` `timezone` `serviceAreas[]` `businessHours[]`
`pricingInfo` `emergencyContact` `whatsappNumber` `defaultRegionPrefix`.

`whatsappNumber` must be E.164. Clearing it stops notifications; leads are still
created.

### `PUT /api/business/settings` *(owner, manager)*

`greeting` `tone` `businessInstructions` `faq[]` `fallbackBehavior` `voiceId`
`language` `maxCallSeconds`.

> `businessInstructions` is capped at 2000 characters and rendered into the
> prompt inside a fenced, explicitly-untrusted block. It shapes wording only.
> There is deliberately **no field that accepts a system prompt**: the workflow,
> the guardrails and the "only state configured facts" rule are not
> tenant-configurable, because a tenant who could edit them could make the
> receptionist quote prices or promise arrival times.

`faq` entries are the only source the receptionist may answer questions from.
Anything not covered becomes a callback request rather than a guess.

### Services

- `GET /api/business/services`
- `POST /api/business/services` *(owner, manager)* — `{ name, description?, sortOrder? }`
- `PATCH /api/business/services/:id` *(owner, manager)*
- `DELETE /api/business/services/:id` *(owner, manager)* → `204`

### `POST /api/business/phone-numbers` *(owner)*

```json
{ "e164": "+924235000001" }
```

Routes inbound calls on that number to this business. Until a number is
registered, calls to it are answered with an apology.

---

## Telephony webhooks

Not for API consumers. Authenticated by `X-Twilio-Signature` against
`PUBLIC_BASE_URL`; an invalid signature is a `403`.

| | |
|---|---|
| `POST /api/telephony/twilio/voice` | Inbound call. Returns `<Gather>` or `<Connect><Stream>` per `VOICE_PIPELINE` |
| `POST /api/telephony/twilio/turn` | One conversational turn (gather pipeline) |
| `POST /api/telephony/twilio/status` | Call completion — what turns a hang-up into a finalised call |
| `WS /api/telephony/twilio/media` | Media Streams audio (stream pipeline) |

---

## Development only

`POST /api/dev/conversations`, `/turn`, `/event` — the text simulator. Drives the
identical path a phone call takes. Unauthenticated, gated behind
`ENABLE_DEV_SIMULATOR`, and the config schema refuses to boot with it enabled
under `NODE_ENV=production`. See
[local-development.md](local-development.md).

---

## Errors

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Request validation failed",
  "details": [{ "path": "whatsappNumber", "message": "must be in E.164 format" }],
  "path": "/api/business"
}
```

| | |
|---|---|
| 400 | Validation failed; `details` names the fields |
| 401 | Missing, expired or tampered token |
| 403 | Insufficient role, or an invalid Twilio signature |
| 404 | Not found, **or** belongs to another tenant |
| 409 | Email already registered |
| 429 | Rate limited |
| 500 | Unexpected. The detail is logged, never returned |

## Rate limits

120 requests/minute by default (`RATE_LIMIT_MAX`, `RATE_LIMIT_TTL`), with
tighter limits on registration (5/hour) and login (10/15min).
