import { APPROVED_SOURCE_IDS } from './guidance.js';
import type { AssistantOutput } from './schema.js';
import type { AirQualitySnapshot } from '../google/types.js';

export interface SafetyContext {
  snapshot: AirQualitySnapshot | null;
  /** Source ids the assistant was actually given. Citations outside this set are fabricated. */
  allowedSourceIds?: ReadonlySet<string>;
}

export interface Violation {
  rule: string;
  detail: string;
}

interface Rule {
  rule: string;
  re: RegExp;
  detail: string;
}

const TEXT_RULES: Rule[] = [
  {
    rule: 'diagnosis',
    re: /\byou (have|likely have|probably have|are suffering from|suffer from|developed)\b[^.]{0,40}\b(asthma|copd|bronchitis|pneumonia|infection|cancer|disease|condition|allerg)/i,
    detail: 'Diagnosing a condition is not allowed.',
  },
  {
    rule: 'diagnosis',
    re: /\b(this|that) (is|sounds like|looks like) (asthma|copd|bronchitis|pneumonia|an? (infection|allergy))\b/i,
    detail: 'Diagnosing a condition is not allowed.',
  },
  { rule: 'diagnosis', re: /\bi (can )?diagnos/i, detail: 'The assistant must not diagnose.' },
  {
    rule: 'medication',
    re: /\b(increase|decrease|reduce|raise|double|halve|skip|stop|start|change|adjust|switch|take|use)\b[^.]{0,30}\b(your|the)?\s*(medication|medicine|inhaler|dose|dosage|steroid|antihistamine|prescription|pills?)\b/i,
    detail: 'Medication changes are not allowed.',
  },
  {
    rule: 'medication',
    re: /\b\d+\s?(mg|mcg|µg|ml|puffs?)\b/i,
    detail: 'Dosing information is not allowed.',
  },
  {
    rule: 'certainty',
    re: /\b(completely|totally|entirely|100%|absolutely|perfectly)\s+(safe|protected|risk[- ]free|harmless)\b/i,
    detail: 'Unsupported certainty about safety.',
  },
  {
    rule: 'certainty',
    re: /\b(eliminates?|removes? all|prevents? all|guarantees?|guaranteed|no risk|zero risk|risk[- ]free|will not (harm|affect)|cannot (harm|affect))\b/i,
    detail: 'Claims that an action eliminates risk are not allowed.',
  },
  {
    rule: 'unsafe_indoor',
    re: /\bozone generators?\b(?![^.]{0,60}\b(avoid|do not|don'?t|never|not recommended)\b)/i,
    detail: 'Ozone-producing devices must not be recommended.',
  },
  {
    rule: 'unsafe_indoor',
    re: /\b(burn|light|use)\b[^.]{0,20}\b(incense|candles?|charcoal|wood|coal|kerosene|stove for heat(ing)?)\b[^.]{0,40}\bindoors?\b/i,
    detail: 'Burning sources indoors must not be recommended.',
  },
  {
    rule: 'unsafe_indoor',
    re: /\b(seal|block|tape)\b[^.]{0,30}\b(all )?(vents?|ventilation|chimney|flue|exhaust)\b/i,
    detail: 'Blocking combustion ventilation is unsafe.',
  },
  {
    rule: 'unsafe_indoor',
    re: /\b(gas|charcoal) (stove|oven|grill|heater)\b[^.]{0,40}\bto (heat|warm)\b/i,
    detail: 'Using combustion appliances for heating is unsafe.',
  },
  {
    rule: 'impersonation',
    re: /\bi am (an? )?(emergency|doctor|physician|nurse|medical professional|paramedic)\b/i,
    detail: 'The assistant must not present as a medical or emergency service.',
  },
  {
    rule: 'fabricated_service',
    re: /(\+?\d[\d\s().-]{8,}\d)/,
    detail: 'Phone numbers must not be invented.',
  },
  {
    rule: 'fabricated_service',
    re: /\b(?:[Cc]all|[Vv]isit|[Cc]ontact|[Gg]o to|[Ss]ee)\s+(?:the\s+)?[A-Z][\w'-]+(\s+[A-Z][\w'-]+){0,3}\s+([Cc]linic|[Hh]ospital|[Pp]harmacy|[Cc]entre|[Cc]enter|[Hh]elpline|[Ss]ervice)\b/,
    detail: 'Specific local services must not be invented.',
  },
];

const URL_RE = /\bhttps?:\/\/[^\s)]+|\bwww\.[^\s)]+/gi;
const AQI_CLAIM =
  /\b(?:aqi|air quality index|index)\b[^\d\n]{0,25}(\d{1,3}(?:\.\d+)?)|(\d{1,3}(?:\.\d+)?)\s*(?:on the\s+)?(?:aqi|air quality index)\b/gi;

function allText(o: AssistantOutput): string {
  return [
    o.directAnswer,
    ...o.recommendedActions.flatMap((a) => [a.title, a.detail]),
    o.rationale,
    o.feasibleAlternative,
    ...o.assumptions,
    o.safetyNotice ?? '',
    o.uncertainty,
  ].join('\n');
}

function allowedAqiValues(s: AirQualitySnapshot | null): Set<number> {
  const set = new Set<number>();
  for (const i of s?.indexes ?? []) {
    set.add(i.aqi);
    set.add(Math.round(i.aqi));
  }
  return set;
}

const CURRENT_CONDITIONS =
  /\b(right now|currently|today)\b[^.]{0,60}\b(is|are)\b[^.]{0,30}\b(good|moderate|unhealthy|hazardous|clean|poor|safe)\b/i;

const ruleViolations = (text: string): Violation[] =>
  TEXT_RULES.filter((r) => r.re.test(text)).map((r) => ({ rule: r.rule, detail: r.detail }));

/** AQI numbers: only values present in the verified snapshot may be quoted. Without a snapshot, none may. */
function aqiViolations(text: string, snapshot: AirQualitySnapshot | null): Violation[] {
  const allowed = allowedAqiValues(snapshot);
  return [...text.matchAll(AQI_CLAIM)]
    .map((m) => Number(m[1] ?? m[2]))
    .filter((n) => Number.isFinite(n) && !allowed.has(n) && !allowed.has(Math.round(n)))
    .map((n) => ({
      rule: 'fabricated_aqi',
      detail: snapshot
        ? `AQI value ${n} is not in the verified snapshot.`
        : `AQI value ${n} was quoted but no verified data is available.`,
    }));
}

const urlViolations = (text: string): Violation[] =>
  (text.match(URL_RE) ?? []).map((u) => ({
    rule: 'fabricated_citation',
    detail: `URL not allowed in assistant output: ${u.slice(0, 60)}`,
  }));

/** Without a verified snapshot the assistant must say so rather than imply current conditions. */
const conditionViolations = (text: string, snapshot: AirQualitySnapshot | null): Violation[] =>
  !snapshot && CURRENT_CONDITIONS.test(text)
    ? [{ rule: 'fabricated_conditions', detail: 'Current conditions were described without verified data.' }]
    : [];

/** Rules that apply to any free text the assistant produces, including live-voice caption transcripts. */
export function checkFreeText(text: string, snapshot: AirQualitySnapshot | null): Violation[] {
  return dedupe([
    ...ruleViolations(text),
    ...aqiViolations(text, snapshot),
    ...urlViolations(text),
    ...conditionViolations(text, snapshot),
  ]);
}

/** Every safety rule an assistant answer breaks, including citations outside the approved list. */
export function checkAssistantOutput(output: AssistantOutput, ctx: SafetyContext): Violation[] {
  const out = checkFreeText(allText(output), ctx.snapshot);
  const allowedIds = ctx.allowedSourceIds ?? APPROVED_SOURCE_IDS;
  for (const s of output.sources) {
    if (!allowedIds.has(s.id) || !APPROVED_SOURCE_IDS.has(s.id)) {
      out.push({ rule: 'fabricated_citation', detail: `Unknown source id: ${s.id.slice(0, 40)}` });
    }
  }
  return dedupe(out);
}

function dedupe(v: Violation[]): Violation[] {
  const seen = new Set<string>();
  return v.filter((x) => {
    const k = `${x.rule}|${x.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Safe, deterministic replacement used when the model output is blocked. Contains no AQI values. */
export function blockedFallback(hasSnapshot: boolean): AssistantOutput {
  return {
    directAnswer:
      'I cannot give a reliable answer to that here. I can share general guidance on timing activities, indoor air and travel choices based on the verified air-quality data shown on this page.',
    recommendedActions: [],
    effortLevel: 'low',
    rationale: 'The generated answer did not pass the safety checks, so it was withheld.',
    feasibleAlternative:
      'Ask about activity timing, indoor quick wins or commute options, or speak with a qualified health professional about personal health questions.',
    exposureOpportunity: 'unknown',
    emissionsOpportunity: 'unknown',
    assumptions: [],
    safetyNotice: hasSnapshot
      ? 'This is general guidance, not medical advice.'
      : 'Live air-quality data is not available, so no conditions are described. This is general guidance, not medical advice.',
    sources: [],
    uncertainty: 'No verified answer was produced.',
  };
}
