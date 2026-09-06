# WhatsApp setup

The lead notification is the product's actual output. Everything else — the
call, the transcript, the dashboard — exists to produce the message that reaches
the tow operator's phone.

```
🚨 NEW TOWING LEAD

Customer: Ahmed
Phone: +92 300 1234567

Service: Vehicle towing

Vehicle:
Toyota Corolla

Vehicle movable:
No

Location:
Liberty Market

Destination:
Not provided

Additional notes:
None

📞 Customer requested towing assistance.

Call received:
Mar 15, 2:17 AM
```

Every line is rendered from the **persisted lead row**, never from model output
or a transcript. Whatever the model may have invented during the call, only
values that survived slot validation and a database write can appear here.

The section order is fixed and empty sections still appear. An operator glancing
at a phone at 2am reads by position; a message whose fields move about depending
on what was collected is worse than one with a couple of "Not provided" lines.

---

## Development: no account needed

```bash
WHATSAPP_PROVIDER=console
```

The message is rendered through the identical code path and written to the API
log instead of being sent. Lead creation, the notification row, the retry
machinery and the delivery log all behave exactly as in production.

---

## The 24-hour window (the thing that catches people out)

WhatsApp splits messages in two:

- **Service messages** — free-form, allowed only within 24 hours of the
  recipient last messaging you.
- **Business-initiated messages** — allowed at any time, but *only* using a
  template approved in advance.

A towing lead is always business-initiated: nobody at the towing company
messaged you first. **Production therefore needs an approved template.** A
free-form body will be accepted in the sandbox and rejected in production, which
is a discouraging way to find out.

---

## Twilio WhatsApp

### Sandbox (testing)

1. Twilio Console → Messaging → Try it out → **Send a WhatsApp message**.
2. From the phone that will receive leads, send the join code shown there to the
   sandbox number.
3. Configure:

```bash
WHATSAPP_PROVIDER=twilio
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886   # the sandbox number
# leave TWILIO_WHATSAPP_CONTENT_SID unset
```

With no content SID the provider sends a plain body, which the sandbox accepts.
The API logs a warning at startup so this cannot be mistaken for a production
configuration.

Sandbox sessions expire every 72 hours and need re-joining.

### Production

1. Register a WhatsApp sender (a real number, through Twilio's onboarding).
2. Create a **content template** with nine positional variables, in this order:

   | | | | |
   |---|---|---|---|
   | 1 customer name | 2 phone | 3 service | 4 vehicle |
   | 5 movable | 6 location | 7 destination | 8 notes |
   | 9 call time | | | |

   Body, matching the layout above:

   ```
   🚨 NEW TOWING LEAD

   Customer: {{1}}
   Phone: {{2}}

   Service: {{3}}

   Vehicle:
   {{4}}

   Vehicle movable:
   {{5}}

   Location:
   {{6}}

   Destination:
   {{7}}

   Additional notes:
   {{8}}

   📞 Customer requested towing assistance.

   Call received:
   {{9}}
   ```

   Submit it for approval under the **Utility** category. Approval usually takes
   minutes to a few hours.

3. Configure:

```bash
TWILIO_WHATSAPP_FROM=whatsapp:+<your approved sender>
TWILIO_WHATSAPP_CONTENT_SID=HX...
```

The variable list is produced by `leadNotificationVariables()`, in the same file
and the same order as the plain-text body, so the two renderings cannot drift
apart.

### Where the leads go

Per business, under **Settings → WhatsApp notifications**, in E.164:

```
+923001234567
```

Leaving it blank stops notifications. **Leads are still created and still
visible in the dashboard** — a missing WhatsApp number costs the operator the
alert, never the lead. The API logs a warning each time this happens.

---

## When delivery fails

The ordering is the guarantee:

```
BEGIN
  INSERT lead
  INSERT notification (status = 'pending')
COMMIT                          ← the lead is durable here
  ↓
attempt delivery
```

Nothing after that commit can lose the lead.

| Status | Meaning |
|---|---|
| `pending` | Written, not yet attempted |
| `sent` | Delivered; `provider_message_id` recorded |
| `failed` | A retryable failure; `next_retry_at` is set |
| `dead` | Attempts exhausted, or a permanently invalid recipient |

Retries back off 5s → 30s → 2m → 10m → 1h. Permanent failures (an invalid
number, an unsubscribed recipient) are not retried at all: hammering them only
delays the operator noticing they need to fix their configuration.

Anything `failed` or `dead` appears on the **Callbacks** page with its last
error and a **Resend** button, which resets the attempt counter and tries again.

A sweeper runs every five seconds and picks up anything due, including work
orphaned by a crash between the commit and the send.

---

## Meta WhatsApp Cloud API

Not implemented. `WhatsAppProvider` is a two-method interface
(`send`, plus a `name`), so a Cloud API adapter is a single file alongside
`twilio.provider.ts` and a new `WHATSAPP_PROVIDER` branch — no change to lead
creation, the retry logic, or the message itself.
