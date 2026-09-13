/**
 * What a caller is likely to say, for speech recognisers that accept a prompt.
 *
 * On a real call Twilio's generic recogniser heard "it has to be towed" as
 * "it has to be told". Telling the recogniser it is listening to a towing call —
 * the business, its areas, the vehicles common locally — is the cheapest fix
 * for that class of mistake.
 */

import type { BusinessFacts } from '@towai/shared';

/** Common in the market this product launches in. */
const COMMON_VEHICLES =
  'Toyota Corolla, Toyota Yaris, Toyota Hilux, Honda Civic, Honda City, Suzuki Mehran, ' +
  'Suzuki Alto, Suzuki Cultus, Suzuki Swift, Kia Sportage, Hyundai Tucson, motorcycle';

export function buildVocabularyHint(
  facts: Pick<BusinessFacts, 'name' | 'serviceAreas'>,
): string {
  const parts = [
    `A phone call to ${facts.name}, a towing company. The caller describes a breakdown, where they are, and their vehicle.`,
    "Likely words: tow, towed, towing, tow truck, flatbed, breakdown, broke down, jump start, flat tyre, accident, won't start.",
  ];
  if (facts.serviceAreas.length > 0) {
    parts.push(`Places: ${facts.serviceAreas.join(', ')}.`);
  }
  parts.push(`Vehicles: ${COMMON_VEHICLES}.`);
  return parts.join(' ');
}
