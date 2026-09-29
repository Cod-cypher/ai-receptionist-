/**
 * Puts the questions in typesafe-questions.ts to Jev on real lines and prints
 * what it decided next to what the rules decide, with the latency of each
 * request.
 *
 *   npm run typesafe:check
 *   npm run typesafe:check -- "on I-95 near the Shell station" "my leg is stuck"
 *
 * For editing the questions: run it, look at the disagreements, change the
 * wording or the thresholds, run it again. Costs a fraction of a cent.
 * Uses TYPESAFE_API_KEY from .env.
 */

import '../../database/load-env';

import { classifyLocation } from '../../conversation/location';
import {
  CONFIRMATION_FLOOR,
  CORRECTION_FLOOR,
  DANGER_FLOOR,
  LOCATION_CONFIDENCE_FLOOR,
  MOVE_CONFIDENCE_FLOOR,
  OVERLAP_ACKNOWLEDGEMENT_CEILING,
  OVERLAP_ANSWER_FLOOR,
  SERVICE_CONFIDENCE_FLOOR,
  SERVICE_LABEL,
  URGENT_FLOOR,
} from './typesafe-questions';
import { TypeSafeJudge } from './typesafe.judge';

const AREAS = ['Dallas', 'Fort Worth', 'Arlington'];

/** From location.test.ts: what the rules call too vague, and what they accept. */
const LOCATIONS = [
  'I-95',
  'on the highway',
  'I-85 near the exit',
  'Main Street',
  'downtown',
  'somewhere near Dallas',
  'Dallas',
  'side of the road',
  'Dakolani',
  'I-95 near exit 42',
  'mile marker 118',
  '123 Main Street',
  'Main Street and Elm',
  'corner of Main and 5th',
  'near Liberty Market',
  'Liberty Market',
  'the Shell station on Highway 10',
  "Love's truck stop off I-40",
  'in the Walmart parking lot on Preston Road',
  'outside the airport',
  'rest area on I-35',
  // Beyond the rules: an unknown two-word place, and a lane on a highway.
  'Piney Woods',
  'middle lane of I-95',
];

const SPEECH = [
  "Yeah, it's on I-85 near the exit, and I need it immediately.",
  'I was in an accident and my friend is hurt',
  'My battery is dead in my driveway.',
  'my car rolled into the ditch and my leg is stuck',
  "there's smoke coming from under the hood",
  'okay',
  'I have my two kids with me and it is getting dark',
];

/** Answers to the read-back "Are these details correct?" */
const READ_BACK = [
  { label: 'Service', value: 'towing' },
  { label: 'Location', value: 'I-95 near exit 42' },
  { label: 'Vehicle', value: 'Honda Civic' },
  { label: 'Callback number', value: '+18174098408' },
];
const ANSWERS_TO_READ_BACK = [
  "Yes, that's right.",
  'Yeah.',
  'Correct, and please hurry.',
  "No wait, it's a Ford.",
  'Actually it is exit 44, not 42.',
  'Hello? Are you there?',
  'How much is it going to cost?',
  'Uh-huh.',
];

/** What the caller said on the real call of 29 September 2026, before any help had been saved. */
const REAL_CALL = [
  'Hey, can you hear me?',
  'Is this audible, like, can you hear me really?',
  "Why do you keep cutting me off? Like, I don't understand that.",
  'Now, like, answer my question, why do you keep cutting me off?',
  'Listen, I need help really quickly.',
  "It's stuck. It's not moving.",
  "Yeah, it's not starting. Like I turned the key in, but the car won't start.",
  'How much is this going to cost me?',
  'Thank you.',
];

/** Saved by the model as the service: what is wrong, not what is wanted. */
const PROBLEMS = ["won't start", "it's stuck, it's not moving", 'blowout', 'battery is dead', 'keys are inside', 'ran out of gas', 'slid into a ditch', 'engine is smoking'];

/** Said over "So that is a Honda Civic at exit 42 on I-95, is that all correct?" */
const RECEPTIONIST_SAID = 'So that is a Honda Civic at exit 42 on I-95, is that all correct?';
const OVERLAPS = ['Okay.', 'Uh-huh.', 'Yes.', 'No, exit 44.', 'Sorry, what?', 'Hello?', 'Right, exit 14.', 'Got it, cheers.'];

async function main(): Promise<void> {
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) {
    console.error('\n✗ TYPESAFE_API_KEY is not set in .env.\n');
    process.exit(1);
  }
  const judge = new TypeSafeJudge({
    apiKey,
    model: process.env.TYPESAFE_MODEL?.trim() || undefined,
    timeoutMs: Number(process.env.TYPESAFE_TIMEOUT_MS) || undefined,
    onWarning: (message) => console.warn(`! ${message}`),
  });
  const own = process.argv.slice(2);
  const locations = own.length > 0 ? own : LOCATIONS;
  const speech = own.length > 0 ? own : SPEECH;
  const latencies: number[] = [];
  let disagreements = 0;

  console.log(`Locations (floor ${LOCATION_CONFIDENCE_FLOOR}): Jev vs the rules\n`);
  for (const text of locations) {
    const rules = classifyLocation(text, { knownAreas: AREAS }).status;
    const started = Date.now();
    const judged = await judge.judgeLocation(text, AREAS);
    const ms = Date.now() - started;
    latencies.push(ms);
    if (!judged?.location) {
      console.log(`  ${pad(text)}  rules ${rules}   Jev: no answer   ${ms} ms`);
      continue;
    }
    const { status, confidence, probabilities } = judged.location;
    const used = confidence >= LOCATION_CONFIDENCE_FLOOR;
    const differs = used && status !== rules;
    if (differs) disagreements += 1;
    const hazard = judged.risk && judged.risk.danger >= DANGER_FLOOR ? `  danger ${judged.risk.danger.toFixed(2)} ${judged.risk.hazard} ✓` : '';
    console.log(
      `${differs ? '≠' : ' '} ${pad(text)}  rules ${pad(rules, 8)}  Jev ${pad(status, 8)} ${confidence.toFixed(2)}${used ? '' : ' (below floor: rules decide)'}` +
        `  p=${['0', '1', '2'].map((l) => (probabilities[l] ?? 0).toFixed(2)).join('/')}${hazard}  ${ms} ms`,
    );
  }

  console.log(`\nSpeech (danger floor ${DANGER_FLOOR}, urgent floor ${URGENT_FLOOR})\n`);
  for (const text of speech) {
    const started = Date.now();
    const judged = await judge.judgeSpeech(text, { location: 'I-85 near the exit' });
    const ms = Date.now() - started;
    latencies.push(ms);
    if (!judged?.risk) {
      console.log(`  ${pad(text, 60)}  Jev: no answer   ${ms} ms`);
      continue;
    }
    const { danger, hazard, hazardProbability, urgent } = judged.risk;
    const dangerUsed = danger >= DANGER_FLOOR;
    const urgentUsed = urgent !== null && urgent >= URGENT_FLOOR;
    console.log(
      `  ${pad(text, 60)}  danger ${danger.toFixed(2)}${dangerUsed ? ' ✓' : '  '} ${pad(hazard, 13)} ${hazardProbability.toFixed(2)}` +
        `  urgent ${(urgent ?? 0).toFixed(2)}${urgentUsed ? ' ✓' : '  '}  ${ms} ms`,
    );
  }

  if (own.length === 0) {
    console.log(`\nThe real call of 29 September, line by line (move floor ${MOVE_CONFIDENCE_FLOOR}, service floor ${SERVICE_CONFIDENCE_FLOOR})\n`);
    for (const text of REAL_CALL) {
      const started = Date.now();
      const judged = await judge.judgeSpeech(text, { location: 'side of the highway', serviceMissing: true });
      const ms = Date.now() - started;
      latencies.push(ms);
      if (!judged?.move) {
        console.log(`  ${pad(text, 62)}  Jev: no answer   ${ms} ms`);
        continue;
      }
      const { move, confidence } = judged.move;
      const answered = move !== 'request' && move !== 'other' && confidence >= MOVE_CONFIDENCE_FLOOR;
      const service = judged.service;
      const help = !service
        ? ''
        : service.service !== 'unclear' && service.confidence >= SERVICE_CONFIDENCE_FLOOR
          ? `  saves ${SERVICE_LABEL[service.service]} (${service.confidence.toFixed(2)})`
          : service.alternatives.length > 0
            ? `  offers ${service.alternatives.map((kind) => SERVICE_LABEL[kind]).join(' or ')}`
            : '';
      console.log(`  ${pad(text, 62)}  ${pad(move, 10)} ${confidence.toFixed(2)}${answered ? ' ✓' : '  '}${help}  ${ms} ms`);
    }

    console.log(`\nA problem saved as the help needed\n`);
    for (const said of PROBLEMS) {
      const started = Date.now();
      const judged = await judge.judgeService(said, { location: 'I-88, mile marker 23' });
      const ms = Date.now() - started;
      latencies.push(ms);
      const service = judged?.service;
      if (!service) {
        console.log(`  ${pad(said, 40)}  Jev: no answer   ${ms} ms`);
        continue;
      }
      const sure = service.service !== 'unclear' && service.confidence >= SERVICE_CONFIDENCE_FLOOR;
      const verdict = sure
        ? `saves ${SERVICE_LABEL[service.service as keyof typeof SERVICE_LABEL]}`
        : `offers ${service.alternatives.map((kind) => SERVICE_LABEL[kind]).join(' or ') || 'nothing: asks what they need'}`;
      console.log(`  ${pad(said, 40)}  ${pad(service.service, 13)} ${service.confidence.toFixed(2)}  → ${verdict}  ${ms} ms`);
    }

    console.log(`\nAnswers to the read-back (confirmation floor ${CONFIRMATION_FLOOR}, correction floor ${CORRECTION_FLOOR})\n`);
    for (const text of ANSWERS_TO_READ_BACK) {
      const started = Date.now();
      const judged = await judge.judgeSpeech(text, {
        location: 'I-95 near exit 42',
        pending: { kind: 'details', question: 'Are these details correct?', readBack: READ_BACK },
      });
      const ms = Date.now() - started;
      latencies.push(ms);
      const c = judged?.confirmation;
      if (!c) {
        console.log(`  ${pad(text, 40)}  Jev: no answer   ${ms} ms`);
        continue;
      }
      const verdict = c.confirms >= CONFIRMATION_FLOOR && c.corrects < CORRECTION_FLOOR ? 'confirmed' : c.corrects >= CORRECTION_FLOOR ? 'correction' : 'not a yes';
      console.log(`  ${pad(text, 40)}  confirms ${c.confirms.toFixed(2)}  corrects ${c.corrects.toFixed(2)}  → ${pad(verdict, 10)}  ${ms} ms`);
    }

    console.log(`\nSaid over the receptionist (answer floor ${OVERLAP_ANSWER_FLOOR}, acknowledgement ceiling ${OVERLAP_ACKNOWLEDGEMENT_CEILING})\n`);
    for (const text of OVERLAPS) {
      const started = Date.now();
      const judged = await judge.judgeOverlap(text, RECEPTIONIST_SAID);
      const ms = Date.now() - started;
      latencies.push(ms);
      const a = judged?.overlap?.answers;
      if (a === undefined) {
        console.log(`  ${pad(text, 40)}  Jev: no answer   ${ms} ms`);
        continue;
      }
      const verdict = a >= OVERLAP_ANSWER_FLOOR ? 'answer it' : a <= OVERLAP_ACKNOWLEDGEMENT_CEILING ? 'say nothing' : 'word lists';
      console.log(`  ${pad(text, 40)}  answers ${a.toFixed(2)}  → ${pad(verdict, 11)}  ${ms} ms`);
    }
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  console.log(
    `\n${latencies.length} requests · median ${sorted[Math.floor(sorted.length / 2)]} ms · max ${sorted[sorted.length - 1]} ms` +
      ` · ${disagreements} location${disagreements === 1 ? '' : 's'} where Jev overrules the rules\n`,
  );
}

function pad(text: string, width = 44): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
