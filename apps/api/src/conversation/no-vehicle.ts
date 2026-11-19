/**
 * "I don't have a car.": a caller saying there is no vehicle.
 *
 * On two real calls (09ba2f2a, a0b7d66e) that line was saved as a tow, the
 * second time with "caller doesn't have a car" as what was wrong with the
 * vehicle, and both went into the read-back and the lead. It says nothing
 * about a job: it is something to reply to, like a person would.
 */

/** Things a caller can be without that are not the vehicle: "I don't have a car jack". */
const NOT_THE_VEHICLE = '(?!\\s+(?:jack|keys?|seat|charger|battery|insurance|problem|trouble|issue)\\b)';

/** In the caller's own words: "I don't have a car", "I've got no vehicle". */
const SAID = new RegExp(
  `\\bi\\s+(?:don'?t|do not)\\s+(?:even\\s+|actually\\s+)?(?:have|own)\\s+(?:a|any)\\s+(?:car|vehicle|truck)\\b${NOT_THE_VEHICLE}` +
    `|\\bi(?:'ve| have)\\s+(?:got\\s+)?no\\s+(?:car|vehicle|truck)\\b${NOT_THE_VEHICLE}`,
  'i',
);

/** As the model writes it down: "caller doesn't have a car", "no vehicle". */
const WRITTEN = new RegExp(
  `\\b(?:does|do|did)(?:n'?t| not)\\s+(?:have|own)\\s+(?:a|any)\\s+(?:car|vehicle|truck)\\b${NOT_THE_VEHICLE}` +
    `|\\b(?:has|have|with)\\s+no\\s+(?:car|vehicle|truck)\\b${NOT_THE_VEHICLE}` +
    `|^no\\s+(?:car|vehicle|truck)$`,
  'i',
);

/** The caller's line says they have no vehicle. */
export function saysNoVehicle(line: string): boolean {
  return SAID.test(line);
}

/** The whole line is that and nothing else: no other detail follows it. */
export function saysOnlyNoVehicle(line: string): boolean {
  const rest = line.replace(SAID, '').replace(/^(?:(?:well|but|actually|no|look|um+|uh+|so|oh)[\s,.]+)+/i, '');
  return SAID.test(line) && !/[\p{L}\p{N}]/u.test(rest);
}

/** A value the model saved says there is no vehicle. */
export function writesNoVehicle(value: string): boolean {
  return SAID.test(value) || WRITTEN.test(value.trim());
}
