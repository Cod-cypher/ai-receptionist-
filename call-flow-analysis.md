# Call flow analysis: how a call runs today, and where it can be better

## Context

The hardening pass is committed (12 commits on `feat/typesafe-jev-decisions`). You then asked for an analysis of the call flow itself: what a caller goes through from pickup to goodbye, and what could be improved. This is that analysis, with the improvements I recommend, in priority order, so you can choose which to implement.

Source: the intake rules (`intake.ts`, `next-action.ts`), the prompt (`realtime-instructions.ts`), the gateway, the eval scenarios, and the three live checks run tonight (reply latency 0.8 s on a plain turn, 2.1-2.4 s on a turn that saves a detail). No real-call data: the database read is still blocked.

## The call as it runs today

A cooperative caller on a highway who says everything at once:

| # | Who | What happens | Cost to the caller |
|---|-----|--------------|--------------------|
| 0 | Twilio | Call connects; TwiML; WebSocket; OpenAI session opens; greeting requested | ~1.5-2.5 s of silence before "Thanks for calling…" |
| 1 | Caller | "Hi, I need a tow, my car broke down on I-35 near exit 200." | — |
| | Receptionist | Model calls `update_call_information` → backend saves, Jev judges the location (up to 0.8 s) → next action HANDLE_SAFETY → second model round trip → "Are you and everyone with you safely off the road? If anyone is hurt, call 911." | ~2.1-2.4 s ("Mm-hm." at 1.1 s now that fillers work) |
| 2 | Caller | "Yeah, we're on the shoulder." | |
| | Receptionist | ASK_VEHICLE "What kind of vehicle is it?" | ~0.8 s if nothing saved, ~2 s if "shoulder" is saved |
| 3 | Caller | "A 2018 Honda Civic." | |
| | Receptionist | save → ASK_VEHICLE_MOVABLE "Can it still move, or does it need to be towed?" | ~2 s |
| 4 | Caller | "No, it won't start." | |
| | Receptionist | save → ASK_CUSTOMER_NAME "And your name?" | ~2 s |
| 5 | Caller | "Mike." | |
| | Receptionist | save → CONFIRM_CALLBACK_NUMBER "Is the number you're calling from the best one to reach you?" | ~2 s |
| 6 | Caller | "Yes." | |
| | Receptionist | save (callerIdConfirmed) → CONFIRM_DETAILS: the fixed read-back, number digit by digit, "Is that all correct?" | ~2 s, then ~15 s of read-back |
| 7 | Caller | "Yes." | |
| | Receptionist | `complete_request` → lead + WhatsApp → goodbye → hang-up | |

Seven caller turns, about 90-120 s. Every turn that saves a detail costs two model round trips (tool call, then speech), and the location turn also waits for Jev.

What already works well and should stay: the backend deciding the next question; the priority order (safety, then a location precise enough to drive to, before anything lower); ready answers for "how soon" and "how much"; the fixed read-back; caller-turn counting so the model cannot confirm on the caller's behalf; the hold/resume logic for "okay" over the receptionist; the caps added tonight.

## Findings

| # | Finding | Where | Impact |
|---|---------|-------|--------|
| F1 | **A withheld caller ID is treated as a real number.** `startCall` seeds `customerPhone` with whatever Twilio sends. Twilio's placeholder `+266696687` passes `normalisePhone` (it is a valid Lesotho number); `anonymous`/`restricted` are seeded unvalidated. The receptionist then asks "is the number you're calling from the best one?", the caller says yes, and the lead goes out with a number nobody can dial. | `call-session.service.ts:153`, `phone.ts` | Lost lead on every withheld-number call |
| F2 | **The number is confirmed twice.** Turn 5 asks "is this the best number?"; turn 6 reads the same number back digit by digit and asks "is that all correct?". The second makes the first redundant. | `next-action.ts:255-269`, `renderReadBack` | One whole turn (~6-8 s, one more model round trip, one more place to fumble) on every call |
| F3 | **Two model round trips per detail.** The note tells the model to save first and ask nothing until the fresh state arrives. Necessary when the next question depends on the answer (is "I-35" precise enough?), but not when it does not: after the vehicle comes "can it move?", after that the name, after the name the number, whatever was said. | `realtime-instructions.ts` (beforeSave note), `runTools` | ~0.7-0.9 s on roughly half the detail turns |
| F4 | **"Can it move?" is asked even when the caller has just said it can't.** "It won't start", "engine died", "blowout", "in a ditch" all leave `vehicleMovable` unset until asked, because only the model's `update` sets it. | `slots.ts` requirement `vehicleMovable`, `intake.ts` | A redundant turn on many tow calls; sounds like not listening |
| F5 | **The safety line is the same for every hazard.** A plain highway shoulder stop gets the same "everyone safe and off the road, call 911" as a crash with an injury. Every call from an interstate starts with it. | `next-action.ts` HANDLE_SAFETY ask | Right to say something; heavy for the common case |
| F6 | **"Can it still move, or does it need to be towed?" is asked of a caller who opened with "I need a tow".** The canonical question is service-blind. | `slots.ts:230`, `next-action.ts` | Sounds like not listening |
| F7 | **Jev can add up to 0.8 s to a location turn**, and the rules decide when it times out (it did in tonight's baseline). | `typesafe.judge.ts` `DEFAULT_SAVED_TIMEOUT_MS` | Latency; not configurable |
| F8 | **The greeting waits for OpenAI.** Config load, WebSocket connect, `session.update`, then the greeting response: 1.5-2.5 s of silence after pickup, the caller's first impression. | `handleStart` | Dead air at the worst moment |
| F9 | **A judged "yes" does not complete the request unless the model calls the tool.** The backend already judges confirmations (CONFIRMS/CORRECTS) to *refuse* a false completion; it never uses a clear yes to complete when the model forgets. Tonight's cap ends such calls after four turns with the lead unconfirmed. | `intake.ts` `complete`, `foldJudgment` | Unconfirmed leads that were in fact confirmed |
| F10 | **Every `state` op reloads the business config (3 queries) and the whole transcript** before the reply is requested. Negligible on localhost, 50-200 ms on a hosted database. | `call-session.service.ts` `loadSession` | Latency once deployed |
| F11 | Destination is never asked, even for a tow. | `next-action.ts` `doNotAsk` | The team asks on callback; a product choice, not a bug |

## Decision (1 October 2026)

Steps 3 and 4 below are implemented and committed; both live checks passed. Steps 1, 2 and 5-8 remain recommendations.

You chose steps 3 and 4 for now: **don't ask what the caller has just said, and a safety line that fits the hazard.** Steps 1, 2 and 5-8 stay below as recommendations for a later pass. Same working agreement as tonight: one commit per step, unit tests, a 20-second live check after each since both change what callers hear.

## Implemented on 2 October 2026 (steps 3 and 4)

### Step 3. Do not ask what the caller has just said (F4, F6)

- `apps/api/src/conversation/intake.ts`
  - New `movableFromCondition(accepted, ctx)`, called in `update()` beside `problemAsService`: when `vehicleMovable` is not set (neither sent nor saved) and the condition (`accepted.vehicleCondition ?? ctx.values.vehicleCondition`) plainly means the vehicle cannot move, set `accepted.vehicleMovable = false` and add `vehicleMovable` to the inferred fields. The existing `fieldSources: 'inferred'` and the lead note "Vehicle movable "no" was inferred, not said by the caller" then apply, and the read-back says "it can't move", which the caller can correct.
  - The same in `callerSpeech`, from the spoken line, mirroring `serviceFromSpeech`: the model does not always save the condition.
  - The pattern, in one place (`IMMOBILE` in `intake.ts`): won't/can't/doesn't start, turn over, move, drive, run, roll; engine/motor died, seized, quit; blowout, flat tire/tyre; in a/the ditch; stuck; accident, crash, wreck, rolled over; out of gas/fuel. Not "dead battery" alone: a dead battery rolls, and a jump start caller would have to correct it.
- `apps/api/src/conversation/next-action.ts`: the movable ask is phrased for the service saved. For a tow (`/\btow/i` on `serviceType`): "whether the vehicle can roll and steer, so it can be pulled onto the truck, or is stuck where it is". Otherwise the canonical question as now.
- Tests
  - `intake.test.ts`: "does not ask whether a vehicle that won't start can move, and marks the answer inferred"; "asks about movement when the condition says nothing about it"; "takes the caller's own answer over the inference" (caller says it rolls: `update` with `vehicleMovable: true` overrides, source becomes stated).
  - `next-action.test.ts`: "asks a tow caller whether it can roll, not whether it needs a tow".
  - Eval scenarios unchanged: `urgent-blowout` and `multi-vehicle-condition-location` now infer movability; `garbled-answer` still asks it (no condition given).
- Live: `npm run realtime:eval -- --runs 1 --scenario multi-vehicle-condition-location,garbled-answer` (about 25 s).

### Step 4. A safety line that fits the hazard (F5)

- `apps/api/src/conversation/next-action.ts` HANDLE_SAFETY ask, by `ctx.safety.hazard`:
  - `being stopped on a high-speed road`: "The caller is stopped on a high-speed road. First, in one or two short sentences: check that they are safely off the road and away from traffic, and say that if anyone is hurt they should call {number} right now." Then the required action continues as now.
  - everything else (an accident, a possible injury, fire or fuel risk, being in live traffic, a dangerous situation): the full line as today.
- Tests: `next-action.test.ts` "gives a shoulder stop a short line and a crash the full one"; `intake.test.ts` highway test still expects 911 in the ask.
- Eval: `highway-safety-advice` still requires 911 by turn 1; live run `npm run realtime:eval -- --runs 1 --scenario highway-safety-advice,accident-safety-advice`.

### Verification for both

- `npm run typecheck`, `npm test` after each step; the two live runs above; `npm run test:e2e -w @towai/api` once Postgres on 5433 is back (with `npm run migrate` first, still owed from tonight); one real call.

## Recommended for a later pass

Ordered by value for the caller and the towing team against effort.

### 1. Ask for a number when the caller ID is withheld (F1) — small

- `packages/shared/src/util/phone.ts`: `isCallerId(value)`: E.164, not Twilio's anonymous placeholder, not a word. Test: `+266696687`, `anonymous`, `restricted` are not caller IDs.
- `call-session.service.ts` `startCall`: seed `customerPhone` only from a real caller ID; otherwise seed nothing and set `phoneNeedsCollection`, so the priority engine asks "what's the best number to reach you?" (`ASK_CALLBACK_NUMBER`, which already exists). The realtime prompt's "The caller is ringing from …" line is left out.
- `twilio-voice.controller.ts`: `callerNumber` parameter only when it is a caller ID (the gate already takes it from the record).
- Tests: intake e2e "asks a withheld caller for a number instead of confirming a placeholder".

### 2. Let the read-back confirm the number (F2) — medium

- `next-action.ts`: when `customerPhone` is a caller ID and the caller has not said it is wrong, skip `CONFIRM_CALLBACK_NUMBER` and go to `CONFIRM_DETAILS`; the read-back already reads the number digit by digit. `ASK_CALLBACK_NUMBER` stays for a withheld ID or a caller who said "not this number".
- `intake.ts` `complete`: a confirmed read-back also sets `phoneConfirmed`. `lead-notes.ts`: the "did not confirm it is the best one" note only when the read-back was not confirmed.
- `realtime-instructions.ts`: drop the callback-number example; `renderReadBack` unchanged.
- Eval scenarios: remove the "Yes, this number is the best one." line from `read-back-waits-for-yes` and `question-after-read-back`; `no-self-confirmed-callback-number` becomes "the number is not marked confirmed until the read-back is".
- Tests: 13 assertions in `intake.test.ts` and 2 in `next-action.test.ts` reference the old step; update to the new flow.
- Live: `npm run realtime:eval -- --runs 1 --scenario read-back-waits-for-yes,question-after-read-back`.

### 3 and 4: chosen; see "To implement now" above.

### 5. Skip the second round trip when the next question is fixed (F3) — medium-large, experimental

- `next-action.ts`: `plan.thenAsk` — the ask that follows if the caller answers this question and nothing else: set for ASK_VEHICLE → movable, ASK_VEHICLE_MOVABLE → name, ASK_CUSTOMER_NAME → read-back or number; never for ASK_LOCATION / ASK_LOCATION_DETAIL (the answer decides) or HANDLE_SAFETY.
- `realtime-instructions.ts` note: "If they answered this and gave nothing else, save it and ask, in the same reply: <thenAsk>. If they gave anything more, save it and wait for the fresh state."
- `realtime-voice.gateway.ts` `runTools`: if the tool result's plan matches `thenAsk` and the reply already asked it (`questionsIn` + topic, already in `response-check.ts`), submit the results with a "you have asked; wait for the answer" note and **no** new response (`submitToolResults` gets a `respond: false` option). If the plan differs, request the reply as now: the caller hears one wrong question once.
- `response-check.ts`: the speculated topic is allowed while it is the plan's `thenAsk`.
- Behind `AI_REALTIME_SPECULATE=true` (default off) so the eval harness can compare: `npm run realtime:eval -- --scenario multi-everything,missing-name,missing-vehicle --runs 3` with and without.

### 6. Complete on a judged yes (F9) — small-medium

- `intake.ts` `foldJudgment`: when a details read-back is pending and the judged line is a confirmation (`isConfirmation`, already there) on a later caller turn than the read-back, finish the call as `complete_request` would. The gateway's `judgeLine` already applies the fold; `startTurn`/`judgeLine` handle `ended` as tonight's unconfirmed goodbye does, but with the normal goodbye.
- Only with Jev configured (it is). Tests in `intake.test.ts`; live: `read-back-waits-for-yes`.

### 7. Config cache and a tighter Jev cap (F7, F10) — small

- `call-session.service.ts`: cache `businessConfig.load` per call for the call's lifetime (or 30 s); skip the transcript load for realtime ops that only need its length (`max(turn_index)`).
- `configuration.ts`: `TYPESAFE_SAVED_TIMEOUT_MS` (default 600, was a hard-coded 800).

### 8. A greeting that plays at once (F8) — medium, needs one check against OpenAI's docs

- A `GreetingBank` beside the filler bank: audio per (voice, greeting text), synthesised the first time a tenant's greeting is needed and kept.
- `handleStart`: play the cached greeting as a synthetic item immediately, before the OpenAI session is ready; once ready, add the greeting to the conversation as an assistant message so the model knows it has greeted (needs the assistant-message content type confirmed in the realtime API; if it cannot be added, the note says the greeting was spoken).

### Not recommended now

- Asking the destination for tows (F11): adds a turn to every tow; the team gets it on callback. Only if towing companies ask for it.
- Changing semantic VAD eagerness from `auto`: cut-offs are the complaint I most want to avoid; leave until real calls say otherwise.
- Shortening the read-back: it is the caller's one chance to catch a mishearing.

## Verification of any later step

- After each step: `npm run typecheck`, `npm test`; a 20-second live check where callers would hear the difference; step 5 gets a three-scenario comparison (about 2 minutes, announced first).
- One real call at the end. The flow changes are what a caller hears; only a phone proves them.
