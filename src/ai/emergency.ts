/** Emergency-number table. Only well-established numbers; unknown regions get generic wording, never a guess. */
const NUMBERS: Record<string, string> = {
  US: '911',
  CA: '911',
  MX: '911',
  GB: '999',
  IE: '112',
  IN: '112',
  AU: '000',
  NZ: '111',
  DE: '112',
  FR: '112',
  ES: '112',
  IT: '112',
  NL: '112',
  SE: '112',
  PL: '112',
  PT: '112',
  BR: '192',
  ZA: '112',
  SG: '995',
  JP: '119',
  KR: '119',
  CN: '120',
  AE: '998',
};

export function emergencyNumber(regionCode?: string | null): string | null {
  if (!regionCode) return null;
  return NUMBERS[regionCode.toUpperCase()] ?? null;
}

const EMERGENCY_PATTERNS: RegExp[] = [
  /\bchest (pain|pressure|tightness)\b/i,
  /\b(can'?t|cannot|unable to|struggling to|hard to|difficulty|trouble) (breathe|breathing)\b/i,
  /\bshort(ness)? of breath\b/i,
  /\b(severe|worsening|won'?t stop) (wheez|asthma|cough)/i,
  /\basthma attack\b/i,
  /\b(blue|bluish|grey|gray) (lips|face|skin)\b/i,
  /\b(faint(ed|ing)?|pass(ed|ing)? out|unconscious|unresponsive|collapsed?)\b/i,
  /\bheart attack\b|\bstroke\b/i,
  /\bsuicid|\bkill myself|\bend my life/i,
  /\bemergency\b/i,
  /\b(choking|poison(ed|ing)?)\b/i,
];

export function isEmergencyMessage(text: string): boolean {
  return EMERGENCY_PATTERNS.some((p) => p.test(text));
}

export interface EmergencyResponse {
  kind: 'emergency';
  message: string;
  emergencyNumber: string | null;
  notEmergencyService: true;
}

export function emergencyResponse(regionCode?: string | null): EmergencyResponse {
  const n = emergencyNumber(regionCode);
  const call = n
    ? `Call your local emergency number (${n}) or go to the nearest emergency department now.`
    : 'Call your local emergency number or go to the nearest emergency department now.';
  return {
    kind: 'emergency',
    emergencyNumber: n,
    notEmergencyService: true,
    message:
      `What you describe may need urgent medical attention. ${call} If you are with someone, ask them to stay with you. ` +
      'ClearAir Together is not an emergency service and cannot assess symptoms. ' +
      'If this is about thoughts of harming yourself, please contact local emergency services or a crisis line in your area right away.',
  };
}
