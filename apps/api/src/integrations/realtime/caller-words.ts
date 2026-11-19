/**
 * What a line the caller spoke is, by its words alone: a detail to save, a
 * question to answer, a complaint, a check of the line, small talk, a line
 * cut off mid-sentence, or only a sound of listening.
 *
 * Cheap heuristics, no judge: the gateway uses this the moment the transcript
 * arrives, about 400 ms before the model's first audio, to tell the model in
 * the note what the caller just said and what kind of thing it is. The
 * contract that makes `toolChoice: 'none'` safe on a reply: a line that
 * carries ANY detail is `detail`, even if it also asks something.
 */

import { saysOnlyNoVehicle } from '../../conversation/no-vehicle';

export type CallerWordsKind =
  | 'question'
  | 'complaint'
  | 'line_check'
  | 'small_talk'
  | 'unfinished'
  | 'backchannel'
  | 'asking_for_time'
  | 'detail'
  | 'unknown';

/** Kinds whose line the receptionist must reply to before anything else; none of them carries a detail. */
export const NEEDS_REPLY: readonly CallerWordsKind[] = ['question', 'complaint', 'line_check', 'small_talk', 'unfinished'];

/**
 * Words a caller says to show they are listening, not to take the floor.
 * Said while the receptionist is speaking, they need no reply.
 *
 * The `\b` after each word stops "mm+" splitting a long hum many ways: without
 * it, 28 m's and a word after took 58 ms and every extra m doubled it. It only
 * changes words run together with no space ("okok"), which no transcript has.
 */
const BACKCHANNEL =
  /^(?:(?:ok(?:ay)?|yes|yeah|yep|yup|yea|mm+|m+hm+|mm-?hmm?|uh-?huh|right|sure|alright|all right|got it|i see|go ahead|go on|fine|cool|great|perfect|thanks|thank you|okay then|please)\b[,.!?\s]*)+$/i;

/** True if `text` is only acknowledgement words. */
export function isBackchannel(text: string): boolean {
  return BACKCHANNEL.test(text.trim());
}

/**
 * "Hello?", "are you there?": the caller checking the line is still open.
 * Once they have heard the receptionist speak, the check is answered.
 */
const PRESENCE_CHECK =
  /^(?:(?:hello|hallo|hi|hey|hey there|you there|are you there|anyone there|is anyone there|still there|are you still there|can you hear me|do you hear me)[,.!?\s]*)+$/i;

export function isPresenceCheck(text: string): boolean {
  return PRESENCE_CHECK.test(text.trim());
}

/**
 * "Hold on, let me find the exit number": the caller asking for time. A
 * stranded caller walking to a sign is quiet for longer than seven seconds,
 * and was checked on and then hung up on while doing what they were asked.
 */
const ASKING_FOR_TIME =
  /\b(?:hold on|hang on|one (?:sec(?:ond)?|moment|minute)|(?:just|give me|gimme) (?:a|one) (?:sec(?:ond)?|moment|minute|min)|bear with me|let me (?:check|look|see|find|get|go|ask|have a look)|i(?:'ll| will) (?:check|look|find out|have a look|go and)|wait (?:a|one) (?:sec(?:ond)?|moment|minute)|please wait|stand by)\b/i;

export function isAskingForTime(text: string): boolean {
  return ASKING_FOR_TIME.test(text);
}

/** Letters, and the marks written on them, of any script but the Latin one. */
const OTHER_SCRIPT = /(?:(?!\p{Script=Latin})[\p{L}\p{M}])+/gu;

/**
 * A caller's line with everything not written in Latin script taken out, or
 * null when nothing is left of it. The transcriber is told the call is in
 * English, and takes that as a hint: on a real call (09ba2f2a) it wrote
 * "5522 ہائی وے" for "5522 Highway", the note quoted that to the model, and
 * the model saved it as the location. What it wrote in another script is not
 * what was said; the digits and the Latin words beside it are kept.
 */
export function inLatinScript(text: string): string | null {
  const kept = text
    .replace(OTHER_SCRIPT, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\p{P}]+|\s+(?=[\p{P}]*$)/gu, '')
    .trim();
  return /[\p{L}\p{N}]/u.test(kept) ? kept : null;
}

/**
 * "Um", "uh", "hmm": a sound of thinking with no word in it. The caller has
 * not finished and has asked nothing; the turn detector ends their turn on
 * the pause all the same ("Um" and then "5532" were two turns on a real call,
 * 09ba2f2a). Not with a question mark: "Hm?" and "Ah?" ask for the line again.
 */
const HESITATION = /^(?:(?:u+m+|u+h+m*|e+r+m*|h+m+|a+h+)\b[,.…\s-]*)+$/i;

export function isHesitation(text: string): boolean {
  return HESITATION.test(text.trim());
}

// ---- Detail cues ------------------------------------------------------------
//
// Any one of these makes the line a detail. They lean towards finding a detail:
// a line wrongly called a detail costs at most one tool call that saves
// nothing, while a detail called a question is sent with `toolChoice: 'none'`
// and is not saved on that turn. A plain statement with a detail no cue
// catches ("Dallas.") falls through to `unknown`, which restricts nothing.

/** A number of any kind: an exit, a mile marker, a house number, a phone number, a year. */
const DIGIT = /\d/;

const NUMBER_WORD =
  'zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|double|triple';
// "Oh" and "double" never start a number a caller reads out, and "oh, one second" is not one.
const FIRST_NUMBER_WORD =
  'zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety';

/**
 * A number said in words: two or more number words in a row ("five five five
 * one two", "twenty sixteen", "mile marker one eighteen"), a road word and a
 * number ("exit nine", "I ninety-five"), or a distance ("two miles past").
 * "One second" is none of these.
 */
const SPOKEN_NUMBER = new RegExp(
  `\\b(?:${FIRST_NUMBER_WORD})(?:[\\s-]+(?:${NUMBER_WORD}))+\\b` +
    `|\\b(?:exit|junction|marker|route|highway|interstate|i|gate)[\\s-]+(?:${NUMBER_WORD})\\b` +
    `|\\b(?:${FIRST_NUMBER_WORD})[\\s-]+(?:miles?|kilometers?|kilometres?|km|blocks?|exits?)\\b`,
  'i',
);

/**
 * Road and roadside words that only come up to say where the car is. Not when
 * they are what the caller is going to look for ("let me check the cross
 * street"): that line is the caller asking for time.
 */
const ROAD_WORDS =
  /(?<!\b(?:find|check|see|spot|read|look for|look at|looking for|looking at)\s(?:the|a|an|that|this)\s)\b(?:highway|freeway|interstate|motorway|expressway|turnpike|thruway|beltway|tollway|toll road|bypass|overpass|underpass|on-?ramp|off-?ramp|exit ramp|slip road|service road|frontage road|hard shoulder|shoulder|median|intersection|roundabout|crossroads?|cross street|parking lot|parking garage|parking deck|car park|gas station|petrol station|service station|truck stop|rest stop|rest area|service area|driveway|cul-de-sac|dual carriageway|bus stop|northbound|southbound|eastbound|westbound)\b/i;

/** "Main Street", "Preston Road", "Elm St": a named road. "The street" and "what road" name nothing. */
const NAMED_ROAD =
  /\b(?!(?:the|a|an|this|that|which|what|whatever|my|your|any|some|every|each|next|same|other|one|wrong|different|cross)\b)[a-z][\w'.-]*\s+(?:street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|parkway|pkwy|highway|hwy|freeway|expressway|motorway|turnpike|pike|route|bypass)\b/i;

/** "Fifth Avenue", "the second exit". */
const ORDINAL_ROAD =
  /\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)\s+(?:street|st|avenue|ave|road|rd|exit)\b/i;

/** "Fifth and Main". Case-sensitive, so "a second and let me look" is not a corner. */
const ORDINAL_CORNER = /\b(?:[Ff]irst|[Ss]econd|[Tt]hird|[Ff]ourth|[Ff]ifth|[Ss]ixth|[Ss]eventh|[Ee]ighth|[Nn]inth|[Tt]enth)\s+and\s+[A-Z]/;

/** "Oak Drive", "Union Station", "Joe's Garage": a capitalised name and a place word. */
const CAPITALISED_PLACE =
  /\b[A-Z][a-z']+\s+(?:Drive|Way|Place|Court|Circle|Terrace|Trail|Square|Plaza|Mall|Center|Centre|Park|Station|Bridge|Market|Hospital|School|Church|Airport|Exit|Junction|Garage|Avenue|Street|Road|Lane|Boulevard)\b/;

/**
 * A preposition and a capitalised word: "on Preston", "at the Walmart", "near
 * Dallas". Transcripts capitalise names and places, not ordinary words, so
 * this is the cheapest way to see a place the lists below do not know.
 */
const NAMED_PLACE =
  /\b(?:at|on|near|off|in|by|to|from|outside|behind|past|onto|toward|towards|into|around|as far as)\s+(?:the\s+)?(?!(?:I|I'm|I'll|I've|I'd|OK|Okay|AI|English|Spanish|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|God)\b)[A-Z][\w'&-]*/;

/**
 * Where the car is, said by what is near it: "at the", "near the", "next
 * to", "in front of", "on the shoulder", "at home", a chain the caller can see.
 * "Look at the sign", "at the moment" and "by the way" place nothing.
 */
const LANDMARK = new RegExp(
  [
    "(?<!\\blook(?:ing|ed)? )\\bat the\\b(?! (?:moment|same|end|time|least|most|very|beginning|start)\\b)",
    '\\b(?:near|next to|in front of|across from|opposite|beside|right by|just past|close to)\\b',
    '\\b(?:behind|outside|past) the\\b',
    '\\bby the\\b(?! way\\b)',
    '\\bon the (?:road|street|highway|freeway|interstate|motorway|shoulder|side|corner|bridge|ramp)\\b',
    '\\boff (?:the )?(?:road|highway|freeway|interstate|exit|ramp|motorway)\\b',
    '\\b(?:side|middle|edge) of the (?:road|street|highway|freeway)\\b',
    '\\b(?:at|near|from) (?:home|work|school|church)\\b',
    '\\bin the (?:city|town|village|centre|center|suburbs|countryside|middle of nowhere|left lane|right lane|fast lane|lane)\\b',
    '\\b(?:downtown|uptown|city cent(?:er|re)|town cent(?:er|re)|middle of nowhere|out in the country)\\b',
    "\\b(?:walmart|costco|mcdonald'?s|starbucks|shell|exxon|chevron|mobil|texaco|home depot|lowe'?s|kroger|safeway|walgreens|cvs|wendy'?s|burger king|taco bell|dunkin'?|circle k|wawa|sheetz|quiktrip|buc-?ee'?s|flying j|kfc|subway|pizza hut|dairy queen|ikea|best buy)\\b",
  ].join('|'),
  'i',
);

/** Makes, models and the specific kinds of vehicle: each one is something the towing team needs. */
const VEHICLE = new RegExp(
  '\\b(?:' +
    [
      // Makes.
      'toyota|honda|suzuki|nissan|mazda|kia|hyundai|ford|chevy|chevrolet|gmc|dodge|chrysler|jeep|buick|cadillac|lincoln|tesla|bmw|beemer',
      'mercedes|benz|audi|volkswagen|vw|subaru|mitsubishi|lexus|acura|infiniti|volvo|porsche|jaguar|land rover|range rover|fiat|peugeot',
      'renault|citroen|skoda|opel|vauxhall|daihatsu|proton|isuzu|hino|freightliner|peterbilt|kenworth|mack|navistar|harley|yamaha|kawasaki',
      'ducati|changan|haval|geely|byd|saturn|pontiac|hummer|oldsmobile|scion|saab|rivian|polestar|maserati|ferrari|lamborghini|bentley',
      'rolls royce|alfa romeo|mini cooper',
      // Models, the common ones here and in the launch market (Mehran, Cultus).
      'civic|accord|corolla|camry|prius|highlander|tacoma|tundra|sienna|yaris|hilux|prado|land cruiser|vitz|mehran|alto|cultus|swift',
      'wagon r|mustang|explorer|ranger|bronco|silverado|malibu|tahoe|equinox|camaro|corvette|impala|cruze|altima|sentra|pathfinder|maxima',
      'elantra|sonata|santa fe|sportage|sorento|optima|jetta|passat|tiguan|outback|forester|impreza|wrangler|cherokee|durango|charger',
      'challenger|caravan|pacifica|odyssey|cr-?v|hr-?v|cybertruck|escalade|yukon|sierra',
      // Kinds of vehicle that say more than "car": a semi takes a heavy-duty truck.
      'suvs?|sedan|saloon|coupe|hatchback|convertible|minivan|pickups?|pick-up|semis?|eighteen[- ]wheeler|big rig|tractor[- ]trailer',
      'box truck|flatbed|lorry|motorcycle|motorbike|scooter|moped|trailer|camper|rv|motorhome|motor home|bus|station wagon|tractor',
      'forklift|rickshaw|limo|limousine|taxi|dump truck',
    ].join('|') +
    ')\\b',
  'i',
);

/** Model names that are also everyday words count only as a vehicle: "a Ram", "my Focus". */
const VEHICLE_BY_NAME =
  /(?<=\b(?:[Aa]|[Aa]n|[Mm]y|[Tt]he|[Hh]is|[Hh]er|[Oo]ur|[Tt]heir)\s)(?:Ram|Mini|Focus|Fusion|Escape|Pilot|Rogue|Soul|Golf|Fit|Frontier|Expedition|Edge|City)\b/;

/**
 * "My car", "a truck": the caller's vehicle. "The car" and "your truck" point
 * back at something already said or at the tow truck ("when will the truck
 * get here?"), so they add nothing.
 */
const GENERIC_VEHICLE = /(?<!\b(?:the|that|this|your|tow)\s)\b(?:cars?|trucks?|vans?|bikes?)\b/i;

/**
 * The service. Case-sensitive so a business name ("Joe's Towing", "Is this a
 * towing company?") is not a request, and "the tow" (the one already coming)
 * adds nothing.
 */
const TOW =
  /(?<!\b(?:the|[A-Z][\w']*)\s)\b[Tt]ow(?:s|ed|ing)?\b(?!\s+(?:company|companies|service|services|business|place|people|guys|yard)\b)/;

/** What is wrong, how the car is, and what the team needs to know: each a field the backend saves. */
const PROBLEM = new RegExp(
  '\\b(?:' +
    [
      'jump[- ]?start(?:s|ed|ing)?|a jump|jump (?:it|me|my|the)|boost|batter(?:y|ies)',
      'flat(?!\\s+(?:rate|fee|price|out)\\b)|tires?|tyres?|punctur(?:e|ed)|blow-?out|blew (?:a|out|up)',
      'lock-?out|locked (?:out|my|the|in)|keys? (?:are |is )?(?:locked|inside|in (?:the|my) car)|lost (?:my|the) keys?',
      "won'?t start|wouldn'?t start|will not start|doesn'?t start|does not start|didn'?t start|not starting|won'?t turn (?:on|over)",
      'dead|died|stall(?:ed|ing|s)?|overheat(?:s|ed|ing)?|smok(?:e|ing)|steam(?:ing)?|on fire|fire',
      'accident|crash(?:ed)?|collision|wreck(?:ed)?|totall?ed|rear-?ended|hit (?:a|an|by|the|some)|flipped|rolled over|spun out|slid (?:off|into)',
      'stuck|ditch|mud|snow|fuel|gas|petrol|diesel|ran out|out of gas|empty tank|winch(?:ed|ing)?',
      'broke down|broken down|break ?down|breakdown',
      "won'?t (?:move|drive|go|budge|roll|steer|shift)|can'?t (?:move|drive|roll|steer|shift)|cannot (?:move|drive|roll|steer)|doesn'?t (?:move|drive|roll|steer)|not moving",
      'engine|brakes?|transmission|alternator|radiator|starter|clutch|gearbox|axle|wheels?|leak(?:s|ing)?|coolant|check engine|warning light',
      'spare|bumper|windshield|airbags?|neutral|in park|parking brake|handbrake',
      'injur(?:ed|y|ies)|hurt|bleeding|ambulance|police|cops|unsafe|dangerous|safe|blocking|passengers?|cargo|wheelchair|gate code',
      'license plate|licence plate|plate number|registration',
    ].join('|') +
    ')\\b',
  'i',
);

/** "It still rolls", "the engine runs", "I don't know if it starts": whether the car can move. */
const MOVABLE =
  /\b(?:it|car|truck|vehicle|engine|van)(?:'s)?\b(?:\s+[\w']+){0,3}?\s+(?:roll|rolls|rolling|steer|steers|steering|drives?|driving|drivable|driveable|moves?|moving|runs|running|starts?|starting|turns? (?:on|over))\b/i;

/** "My name is", "my husband's name is Ali", "under the name": the caller giving a name. */
const NAME = /\bname(?:'s| is)\b|\bunder the name\b|\bspelled\b/i;

/**
 * "This is Sarah", "it's Mike", "I'm Ali": an introduction. Case-sensitive: the
 * transcript capitalises the name and nothing else after these words.
 */
const NAME_INTRO =
  /(?:\b[Tt]his is|\b[Ii]t's|\b[Ii]t is|\bI'm|\bI am|\b[Cc]all me|\b[Nn]ame's)\s+(?!(?:I|I'm|I'll|I've|I'd|OK|Okay|AI|A|An|The|Not|So|Just|Sorry|Hello|Hi|Hey|Yes|No|Yeah|Fine|Good|Great|Here|There|Still|Really|Very|Sure|What|Where|Why|How|Who|When|Which|That|This|It|It's|My|Your)\b)[A-Z][a-z'-]+/;

/**
 * "I just told you, it's big Michael Michael.": a complaint that gives the
 * answer again. Taken for a complaint alone, the reply to it is sent without
 * tools: on a real call (a0b7d66e) the caller was told sorry and asked their
 * name a third time, with the name in the very line being apologised for.
 */
const RESTATED_ANSWER =
  /\bi (?:just |already |literally |did )?(?:told|said|gave|tell)(?: it to)?(?: you)?(?: that| already| before| once)?[,.:;!]?\s+(?:it'?s|it is|my name(?: is|'s)|i'?m|i am|that'?s|the name(?: is|'s))\s+(?!not\b|still\b|just\b|sorry\b|what\b|why\b)\S+/i;

/** The callback number: "my number", "this number is fine", "call me back on". */
const PHONE =
  /\b(?:my|this|that|same|other|another|different|cell|mobile|work|home|landline|best|callback|call-back) (?:phone |cell |mobile )?number\b|\bnumber (?:i'm|i am) calling (?:from|on)\b|\bcall me (?:back )?(?:on|at)\b|\breach me (?:on|at)\b|\btext me\b|\bmy (?:cell|mobile|landline)\b/i;

/**
 * Urgency and who is with the car, the same words `risk.ts` reads from the
 * spoken line: "it's an emergency", "I've got kids in the car". Children who
 * are there, not children mentioned: "my kid is talking to me" is the caller
 * asking for time.
 */
const URGENCY =
  /\b(?:immediately|right now|right away|asap|a\.s\.a\.p|as soon as possible|urgent(?:ly)?|emergency|hurry|scared|in the dark|pitch black)\b|\b(?:kids?|children|baby|infant|toddler|elderly|pregnant)\b[^.?!]{0,25}\b(?:with me|with us|in the (?:car|vehicle|truck|van|back)|in my (?:car|truck|van)|here with|on board)\b|\b(?:i(?:'ve| have)(?: got)?|we(?:'ve| have)(?: got)?|there(?:'s| are| is)|i(?:'m| am) with) (?:a |an |my |our |two |three |some |the )?(?:kids?|children|baby|infant|toddler|pregnant)\b|\bpregnant\b/i;

/** Where the car should go: "take it to my mechanic", "the dealership". */
const DESTINATION =
  /\b(?:take|tow|bring|drop|haul|move|deliver|get) (?:it|her|him|them|the car|my car|the truck|my truck|the vehicle|my vehicle)\s+(?:to|off|at|home|back|over)\b|\bmy (?:house|home|place|work|office|apartment|job|mechanic|garage|shop|driveway|building)\b|\b(?:mechanic|dealership|dealer|body shop|repair shop|auto shop|tire shop|tyre shop|garage|junkyard|scrapyard|impound)\b/i;

/**
 * Two or three capitalised words and nothing else ("Mike Johnson.", "Grand
 * Prairie?"), or one with a question mark ("Dallas?"): a name or a place,
 * said as the answer to a question. The second form matters most: as a
 * question it would be sent with no tool.
 */
const PROPER_NOUNS = /^([A-Z][a-z'-]+)(?:\s+[A-Z][a-z'-]+){1,2}[.?!]*$/;
const PROPER_NOUN_ASKED = /^([A-Z][a-z'-]+)\?+$/;

/** Words that start a capitalised line without naming anything. */
const NOT_A_NAME = new Set(
  (
    'hello hallo hi hey okay ok yes yeah yep yup yea no nope nah naw right sure alright fine cool great perfect thanks thank ' +
    'please mm mhm mm-hmm uh-huh hmm um uh oh ah wait sorry what why how who where when which whose huh pardon really seriously ' +
    'again now today tomorrow tonight soon later me you it that this here there anyone anybody someone somebody nothing everything ' +
    'anything nobody done ready good nice awesome excellent wonderful lovely brilliant understood gotcha exactly absolutely definitely ' +
    'maybe probably whatever well so and but or correct incorrect wrong true same both never always help stop listen look hold hang ' +
    "go continue excuse bye goodbye cheers wow oops ugh jeez geez man dude bro sir ma'am madam hurry honestly anyway eh hm i i'm " +
    'the a an my your is are was can could do does did will would should have has price cost time name number address location'
  ).split(' '),
);

const DETAIL_CUES: readonly RegExp[] = [
  DIGIT,
  SPOKEN_NUMBER,
  ROAD_WORDS,
  NAMED_ROAD,
  ORDINAL_ROAD,
  ORDINAL_CORNER,
  CAPITALISED_PLACE,
  NAMED_PLACE,
  LANDMARK,
  VEHICLE,
  VEHICLE_BY_NAME,
  GENERIC_VEHICLE,
  TOW,
  PROBLEM,
  MOVABLE,
  NAME,
  NAME_INTRO,
  RESTATED_ANSWER,
  PHONE,
  URGENCY,
  DESTINATION,
];

function carriesDetail(line: string): boolean {
  for (const cue of DETAIL_CUES) if (cue.test(line)) return true;
  const proper = PROPER_NOUNS.exec(line) ?? PROPER_NOUN_ASKED.exec(line);
  return proper !== null && !NOT_A_NAME.has((proper[1] ?? '').toLowerCase());
}

/**
 * A yes or a no at the start of a line answers the question the caller was
 * just asked ("No.", "Yeah it is", "No, that's not my number"), so it is a
 * detail. A bare "Yes." or "Okay." is only a backchannel: the model's normal
 * path handles it.
 */
const YES_NO_HEAD =
  /^(?:yes|yeah|yep|yup|yea|no(?! (?:one|way)\b)|nope|nah|naw|correct|incorrect|exactly|absolutely|definitely|certainly|of course|negative|affirmative|not really|not at all|not exactly|that'?s (?:right|correct|wrong|incorrect|not right|not correct|the one|not it|not the one|not my \w+)|that is (?:right|correct|wrong|not right|not correct)|it is|it isn'?t|it'?s not|it is not|it does|it doesn'?t|it can|it can'?t|it cannot|it will|it won'?t|it did|it didn'?t|i think so|i don'?t think so|i do not think so|i guess so|i guess not|i hope so|i believe so|i said (?:yes|yeah|yep|no|nope)|you got it|you'?ve got it|you have it|sure is|sure does|sure can)\b/i;

/** "No, but are you capable of helping me?": the no is not an answer, the rest is the line. */
const BUT = /^but\b[\s,.]*/i;

// ---- What a line is when it carries no detail ---------------------------------

/**
 * Only acknowledgement: the backchannel words, plus thanks and the like.
 * "Thank you so much" with nothing else is a backchannel.
 */
const ACKNOWLEDGEMENT =
  /^(?:(?:ok(?:ay)?|yes|yeah|yep|yup|yea|mm+|m+hm+|mm-?hmm?|uh-?huh|right|sure|alright|all right|got it|i see|go ahead|go on|fine|cool|great|perfect|thanks|thank you|okay then|please|thank you so much|thanks so much|thank you very much|thanks a lot|thanks a bunch|thanks again|thank you again|appreciate it|i appreciate (?:it|that|you)|much appreciated|no problem|no worries|sounds good|that works|will do|understood|gotcha|got you|i got you|awesome|excellent|wonderful|lovely|brilliant|nice|good|very good|okie dokie|cheers|sir|ma'am|buddy)\b[,.!?\s]*)+$/i;

/** Checks of the line the anchored helper does not take: "Hello, can you hear me okay?", "did I lose you?". */
const LINE_CHECK =
  /\b(?:can|could|do) you (?:still )?hear me\b|\bare you (?:still )?(?:there|with me)\b|\byou still (?:there|with me)\b|\bdid (?:i|we) (?:lose you|get cut off|get disconnected)\b|\b(?:any(?:one|body)|some(?:one|body)) (?:there|on the line)\b|\byou(?:'re| are) breaking up\b|\bis this thing on\b/i;

/**
 * The caller saying they are not being heard or answered. On the 12 Oct call
 * (6d1304af) "I asked you something else." got the next intake question, and
 * the caller hung up two turns later.
 */
const COMPLAINT = new RegExp(
  [
    '\\bcut(?:ting)? me off\\b',
    '\\bkeep (?:cutting|interrupting|asking|repeating|saying)\\b',
    '\\binterrupt(?:ing|ed)? me\\b',
    '\\bstop (?:interrupting|asking|repeating|talking over)\\b',
    '\\btalking over me\\b',
    '\\blet me (?:finish|talk|speak)\\b',
    '\\bnot listening\\b',
    '\\bare you (?:even )?listening\\b',
    '\\basked you\\b',
    '\\b(?:already|just) (?:told|said|gave|answered|asked)\\b',
    '\\byou (?:already|just) asked\\b',
    '\\bi told you\\b',
    '(?<!\\bthank )\\byou keep\\b',
    '\\bnot answering\\b',
    "\\b(?:didn'?t|did not|never|won'?t|don'?t|aren'?t|haven'?t) answer(?:ed|ing)?\\b",
    '\\banswer (?:my|the) question\\b',
    '\\byou(?:\'re| are) ignoring\\b',
    '\\bignoring (?:me|my|what)\\b',
    "\\bthat'?s not what\\b",
    '\\bnot what i (?:asked|said|meant)\\b',
    '\\bi said\\b',
    '\\bhow many times\\b',
    "\\b(?:not|doesn'?t|don'?t) mak(?:e|es|ing) (?:any )?sense\\b",
    '\\bmakes no sense\\b',
    "\\b(?:this|that)(?: is|'s) (?:ridiculous|frustrating|useless|annoying|stupid|crazy)\\b",
    '\\bwaste of (?:my )?time\\b',
    "\\byou(?:'re| are) (?:useless|annoying|rude|not getting it)\\b",
    '\\bnot helping\\b',
    '\\bsame question\\b',
    '\\brepeating yourself\\b',
  ].join('|'),
  'i',
);

/**
 * Small talk, answered like a person ("How's the weather today?" on the 12
 * Oct call). "Are you a real person?" is here too: the honesty rules for the
 * answer live in the prompt; this only says it wants a person's answer.
 */
const SMALL_TALK = new RegExp(
  [
    "\\bhow (?:are|r) (?:you|ya|u)(?: (?:doing|doin'?|today|tonight|this|fine|day|morning|afternoon|evening|going|holding up|keeping|sir|ma'am|there|guys|all))*\\s*(?:[,.!?]|$)",
    "\\bhow (?:you|ya) doin'?g?\\b",
    "\\bhow(?:'s| is| has) (?:it going|everything|things|life|your day|your morning|your afternoon|your evening|your night|your week|the weather|work|business)\\b",
    "\\bhow(?:'re| are) things\\b",
    '\\bhow have you been\\b',
    "\\bwhat'?s up\\b(?! with)",
    "\\bwhat'?s new\\b",
    '\\bweather\\b',
    '\\bis it (?:raining|snowing|sunny|hot|cold|nice|windy|warm|cloudy)\\b',
    '\\b(?:are you|is this|is that|am i (?:talking|speaking) (?:to|with))(?: a| an)?(?: real| actual| live)? (?:robot|bot|machine|computer|recording|human|person|ai|a\\.i\\.|artificial intelligence|automated|real)\\b',
    "\\byou(?:'re| are)(?: a| an)? (?:robot|bot|machine|computer|ai)\\b",
    '\\bgood (?:morning|afternoon|evening)\\b',
    '\\bnice (?:to (?:meet|talk to) you|day)\\b',
    '\\bhave a (?:good|nice|great|lovely|blessed) (?:day|one|night|evening|weekend)\\b',
    "\\bhope you(?:'re| are) (?:well|doing well|good|having a good day)\\b",
    '\\bwhere are you from\\b',
    '\\bare you (?:busy|having a good day)\\b',
  ].join('|'),
  'i',
);

/** A question with no question form: "I don't understand", "I was wondering whether you…". */
const INDIRECT_QUESTION = new RegExp(
  [
    "\\bi (?:don'?t|do not) (?:understand|get it|follow)\\b",
    "\\bi'?m (?:confused|not following)\\b",
    '\\bwhat do you mean\\b',
    '\\bsay (?:that|it) again\\b',
    '\\brepeat (?:that|yourself|the question|it)\\b',
    '\\bcome again\\b',
    '\\bpardon\\b',
    "\\bi didn'?t (?:catch|get|hear|understand) (?:that|you|it|what you said)\\b",
    '\\bi (?:have|got) a question\\b',
    '\\b(?:quick|one more|another) question\\b',
    '\\bcan i ask\\b',
    '\\bi (?:was )?wonder(?:ing)? (?:if|whether|how|what|when|why)\\b',
    "\\bi(?:'d| would) like to know\\b",
    '\\bi (?:want|need) to know\\b',
    '\\btell me (?:what|how|when|where|why|who|if|whether)\\b',
    '\\b(?:talk|speak) (?:to|with) (?:a |an |the |your )?(?:real |actual |live )?(?:human|person|manager|operator|supervisor|owner|dispatcher|someone|somebody|anyone|anybody)\\b',
  ].join('|'),
  'i',
);

/** A line that opens like a question: a wh-word or an inverted auxiliary. */
const QUESTION_START =
  /^(?:what|where|when|why|how|who|whose|which|can|could|do|does|did|is|are|was|were|will|would|should|shall|have|has|may|might|am)\b/i;

/**
 * Sounds and discourse words a line opens with ("um", "okay so", "Now, what
 * kind of information…"). Stripped before the checks that read how a line
 * begins; each must be followed by more words.
 */
const LEADING_FILLER =
  /^(?:(?:u+m+|u+h+|uhm+|erm?|a+h+|o+h+|h+m+|m+|so|well|okay|ok|alright|all right|now|look|listen|and|but|like|sorry|wait|hello|hi|hey|right)\b[,.!?]*\s+)+/i;

// ---- A line cut off mid-sentence ---------------------------------------------
//
// On the 12 Oct call the caller's "Okay, so what happens if we try to" was cut
// off by the turn detector and answered with "Where is the vehicle right
// now?". The transcript then has no closing punctuation and ends on a word no
// sentence ends on. Transcripts of finished lines often lack the full stop
// too, so a line that ends on a content word ("I need a tow") is never
// unfinished.

/** Ends with a trailing comma, dash or ellipsis: the caller trailed off. */
const TRAILING_OFF = /(?:\.\.\.|\u2026|[,;:\u2013\u2014-])\s*$/;
const TERMINAL = /[.?!]["')\]]*$/;
const WORD = /[a-z0-9]+(?:['-][a-z0-9]+)*/g;

function words(list: string): ReadonlySet<string> {
  return new Set(list.split(' '));
}

/** Words no complete sentence ends on: articles, conjunctions, possessives, contracted subjects. */
const ALWAYS_OPEN = words(
  "the a an and but or nor if because cause cuz unless until whether than my your our their its i'm im we're you're they're he's " +
    "she's it's that's there's what's where's who's how's i'll we'll you'll they'll it'll he'll she'll that'll there'll i'd we'd you'd " +
    "they'd he'd she'd i've we've you've they've gonna wanna gotta um umm uh uhh uhm er erm just so",
);
/** "I think so", "even so": the only ways a sentence ends on "so". */
const SO_CLOSERS = words('think guess hope believe said say says do did not is told even');
/** Subject pronouns: "so we", "can I". Finished only after a form of "be" ("where am I", "where are they"). */
const NOMINATIVE = words('i we they he she');
const BE = words('am are is was were');
/** Forms of "be" a line can be cut off on: "the car is". */
const COPULA = words('am are is was were be been');
/** "That's where it is", "I don't know what the problem is": an embedded clause ends on "is". */
const CLAUSE_WORD = words('where what who how which whatever wherever whoever when why here there');
const PRONOUN = words('i you we they he she it that this there here');
/** Before "you" or "it" at the end, these mean a verb is still to come: "if you", "can it". */
const CLAUSE_OPENERS = words('and but or so if because cause when while until unless whether that what where how why who which once then');
const NON_BE_AUX = words(
  "do does did can could will would should shall may might must have has had don't doesn't didn't can't won't wouldn't couldn't shouldn't",
);
/** "Try to", "want to", "going to": an infinitive is still to come. */
const CATENATIVE = words(
  'try trying tried want wants wanted need needs needed have has had going got supposed able like liked love hope hoping plan ' +
    'planning meant ought used asked ask tell told decided start started begin began how where what when whether about wish expect ' +
    'expected seem seems seemed afraid',
);
/** "I'm on", "it's in": a place is still to come. "Come on", "turn it on" are finished. */
const PLACE_PREPOSITION = words('on in at off near');
const BEFORE_A_PLACE = words(
  "i'm im we're you're they're it's he's she's is are was were am be been i we it they he she that's there's still stuck parked " +
    'sitting stopped located standing waiting right just currently',
);
/** "The problem is that", "I think that": a clause is still to come. */
const THAT_LEAD = words('think thought said say says mean meant is was so guess believe hope sure told tell realize realise feel felt seems and but or because except now');
const TRY_LEAD = words('we you they i he she if and but when');
/** "Okay then", "see you then", "since then": finished. */
const THEN_CLOSERS = words('okay ok alright since by until till right fine well good you now back see');
/**
 * Words a question may end on ("who am I talking to?", "what's that for?")
 * but a statement may not ("I'm calling about"). Unfinished unless the line
 * opens like a question.
 */
const OPEN_UNLESS_ASKED = words('to of for with about from into onto like when what where how why who which');

function isUnfinished(line: string, stripped: string): boolean {
  if (TRAILING_OFF.test(line)) return true;
  if (TERMINAL.test(line)) return false;
  const tokens = line.toLowerCase().match(WORD);
  if (!tokens) return false;
  const last = tokens[tokens.length - 1] ?? '';
  const prev = tokens[tokens.length - 2] ?? '';
  if (ALWAYS_OPEN.has(last)) return !(last === 'so' && SO_CLOSERS.has(prev));
  if (NOMINATIVE.has(last)) return !BE.has(prev);
  if (last === 'you' || last === 'it') return CLAUSE_OPENERS.has(prev) || NON_BE_AUX.has(prev);
  if (COPULA.has(last)) return !PRONOUN.has(prev) && !endsInClause(tokens);
  if (last === 'to' && CATENATIVE.has(prev)) return true;
  if (PLACE_PREPOSITION.has(last)) return BEFORE_A_PLACE.has(prev);
  if (last === 'that') return THAT_LEAD.has(prev) && !QUESTION_START.test(stripped);
  if (last === 'try') return TRY_LEAD.has(prev);
  if (last === 'then') return !THEN_CLOSERS.has(prev) && !QUESTION_START.test(stripped);
  if (OPEN_UNLESS_ASKED.has(last)) return !QUESTION_START.test(stripped);
  return false;
}

/** A wh-word one to three words before the final "is": "where it is", "what the problem is". */
function endsInClause(tokens: readonly string[]): boolean {
  const n = tokens.length;
  for (let j = n - 3; j >= Math.max(0, n - 5); j--) if (CLAUSE_WORD.has(tokens[j] ?? '')) return true;
  return false;
}

/**
 * A line the transcriber closed with a mark though the caller was cut off.
 * It wrote "Okay, so what happens if we try to?" on one take and "...try
 * to." on the next, so the mark says nothing. Only the two endings no
 * finished sentence has are trusted against it: a word that always wants
 * another ("the", "and", "if"), or "to" after a verb that takes one ("try
 * to", "want to"). Short lines are left alone: "Can you?" is a question.
 */
function cutOffDespiteMark(line: string): boolean {
  const bare = line.replace(/[.?!]+$/, '').trimEnd();
  if (bare === line || /[.?!]/.test(bare)) return false;
  const tokens = bare.toLowerCase().match(WORD);
  if (!tokens || tokens.length < 5) return false;
  const last = tokens[tokens.length - 1] ?? '';
  const prev = tokens[tokens.length - 2] ?? '';
  if (last === 'to') return CATENATIVE.has(prev);
  return ALWAYS_OPEN.has(last) && !(last === 'so' && SO_CLOSERS.has(prev));
}

// ---- The classifier ----------------------------------------------------------

/** Curly apostrophes to straight ones, runs of space to one, ends trimmed. */
function normalise(text: string): string {
  return text.replace(/[\u2018\u2019\u02bc]/g, "'").replace(/\s+/g, ' ').trim();
}

/**
 * The kind of line `text` is. A line that carries any detail is `detail`,
 * whatever else it does, so the kinds in `NEEDS_REPLY` never carry one and a
 * reply to them can safely be sent with `toolChoice: 'none'`. Then, in order:
 * backchannel, line check, asking for time, complaint (it beats a question:
 * "Why do you keep cutting me off?"), small talk, question, unfinished,
 * unknown. Runs on every caller turn: regular expressions and set lookups only.
 */
export function classifyCallerWords(text: string): CallerWordsKind {
  const line = normalise(text);
  if (!line) return 'unknown';
  // "I don't have a car." names a car and gives no detail of any job. Taken
  // for a detail, the model was told to save it, and saved a tow (two real
  // calls). It is someone talking, to be replied to.
  if (saysOnlyNoVehicle(line)) return 'unknown';
  if (carriesDetail(line)) return 'detail';
  if (!ACKNOWLEDGEMENT.test(line) && !isBackchannel(line)) {
    const stripped = line.replace(LEADING_FILLER, '');
    const head = YES_NO_HEAD.exec(stripped);
    if (head) {
      const rest = stripped.slice(head[0].length).replace(/^[\s,.!?]+/, '');
      if (BUT.test(rest)) {
        const after = rest.replace(BUT, '');
        return after ? withoutDetail(after) : 'unfinished';
      }
      // "No, I asked you something else": the no pushes back, it answers nothing.
      if (!COMPLAINT.test(rest)) return 'detail';
    }
  }
  return withoutDetail(line);
}

/** What a line with no detail and no yes-or-no answer is. */
function withoutDetail(line: string): CallerWordsKind {
  if (ACKNOWLEDGEMENT.test(line) || isBackchannel(line)) return 'backchannel';
  if (isPresenceCheck(line) || LINE_CHECK.test(line)) return 'line_check';
  if (isAskingForTime(line)) return 'asking_for_time';
  if (COMPLAINT.test(line)) return 'complaint';
  if (SMALL_TALK.test(line)) return 'small_talk';
  const stripped = line.replace(LEADING_FILLER, '');
  // The transcriber ends a line that sounds like a question with '?' even when
  // the caller was cut off: a live check heard "Okay, so what happens if we
  // try to?", and the receptionist tried to answer it. A longer line whose
  // last word no sentence ends on is unfinished, whatever mark follows it. A
  // short one ("Can you?", "Is it?") is a question as it stands.
  if (cutOffDespiteMark(stripped)) return 'unfinished';
  if (stripped.includes('?')) return 'question';
  if (isUnfinished(line, stripped)) return 'unfinished';
  if (INDIRECT_QUESTION.test(line) || QUESTION_START.test(stripped)) return 'question';
  return 'unknown';
}

// ---- Yes or no to the question pending -----------------------------------------
//
// The rules' stand-in for the judge's "does the caller confirm / correct". The
// backend acts on a clear yes by itself (it completes the request on one), so
// only a line that is nothing but a yes counts as one. Anything the words
// cannot settle is left to the model, as it was before there was a judge.

/** How a line answers a yes-or-no question, when its words make that plain. */
export type YesNo = 'yes' | 'no' | 'yes_but';

/** A head that says no: "no", "that's wrong", "it's not", "I don't think so". */
const NEGATIVE_HEAD = /\b(?:no|nope|nah|naw|not|incorrect|wrong|negative|cannot)\b|n'?t\b/i;

/** A yes said with doubt is not one the backend can complete a request on. */
const HEDGED_YES = /^(?:i think so|i guess so|i hope so|i believe so)$/i;

/** "No problem", "no worries": not an answer to anything. */
const NOT_A_NO = /^no (?:problem|worries|rush|hurry|doubt|need|thanks|thank you)\b/i;

/**
 * Words that add nothing to a yes: "Yes, that's all correct, thank you",
 * "Yeah, that's my number". A line made only of these, after a yes, is a
 * clear yes; after a no ("No, no, that's right") it is not a clear no.
 */
const AFFIRMATIVE_ONLY =
  /^(?:(?:yes|yeah|yep|yup|yea|ok(?:ay)?|alright|all right|right|sure|correct|exactly|absolutely|definitely|certainly|perfect|great|good|fine|cool|thanks|thank you|please|sir|ma'am|indeed|of course|uh-?huh|mm-?hmm?|m+hm+|that'?s (?:all )?(?:right|correct|it|good|fine|perfect|great|me)|that is (?:all )?(?:right|correct)|it is|it'?s (?:all )?(?:right|correct|good|fine)|(?:it'?s |that'?s )?(?:all|everything) (?:is )?(?:correct|right|good|fine)|everything'?s (?:correct|right|good|fine)|that'?s (?:my|the) (?:number|one|best number|right number)|(?:this|that) (?:number|one)(?: is (?:fine|good|best|right))?|sounds (?:good|right|great|perfect|about right)|looks (?:good|right)|you got it|you'?ve got it|that works|spot on|no problem|no worries)\b[,.!?\s]*)+$/i;

/** Among those, the ones that say yes on their own. "Okay." and "Uh-huh." may only be listening. */
const STRONG_YES =
  /\b(?:yes|yeah|yep|yup|yea|sure|correct|exactly|absolutely|definitely|certainly|perfect|of course|all good|spot on|that'?s (?:all )?(?:right|it|me)|that is (?:all )?right|it is|sounds (?:good|right|great|perfect)|you(?:'ve)? got it)\b/i;

/**
 * Whether `text` answers a yes-or-no question, by its words alone: `yes`
 * only when the line is nothing but a yes ("Yes.", "Yeah, that's all
 * correct", "It is"); `no` for a no or a correction ("No.", "That's wrong",
 * "No, it's 555 0199"); `yes_but` for a yes that goes on to something else
 * ("Yes, but how long will it take?"), which confirms nothing yet. Null when
 * the words do not say.
 */
export function readYesNo(text: string): YesNo | null {
  const line = normalise(text);
  if (!line) return null;
  const stripped = line.replace(LEADING_FILLER, '');
  if (NOT_A_NO.test(stripped)) return null;
  const head = YES_NO_HEAD.exec(stripped);
  if (!head) {
    // "Sounds good.", "Perfect, thank you.": a yes with no yes-word up front.
    return AFFIRMATIVE_ONLY.test(stripped) && STRONG_YES.test(stripped) ? 'yes' : null;
  }
  const said = head[0];
  const rest = stripped.slice(said.length).replace(/^[\s,.!?]+/, '');
  if (HEDGED_YES.test(said)) return null;
  if (NEGATIVE_HEAD.test(said)) {
    // "No, no, that's right": the no waves something off, it does not answer.
    const after = rest.replace(/^(?:no\b[\s,.!]*)+/i, '');
    return after && AFFIRMATIVE_ONLY.test(after) ? null : 'no';
  }
  // The head reads "it is" in "it is not": the not is what was said.
  if (/^(?:it|that)\b/i.test(said) && /^not\b/i.test(rest)) return 'no';
  if (!rest || AFFIRMATIVE_ONLY.test(rest)) return 'yes';
  if (BUT.test(rest) || /\bbut\b/i.test(rest) || rest.includes('?')) return 'yes_but';
  return null;
}
