/**
 * Exposure and emissions are deliberately separate dimensions. An action can lower one without the other
 * (e.g. driving with windows shut lowers personal exposure but not emissions). Both are qualitative
 * effects derived from documented rules, never numbers invented for the user.
 */
export type Effect = 'lower' | 'similar' | 'higher' | 'unknown';
export type Severity = 'good' | 'moderate' | 'sensitive' | 'unhealthy' | 'very_unhealthy' | 'unknown';
export type CommuteMode =
  'walk' | 'cycle' | 'bus' | 'metro' | 'car' | 'two_wheeler' | 'rideshare' | 'unknown';

export interface RoutineOption {
  id: string;
  label: string;
  mode: CommuteMode | 'work_from_home';
  /** Exposure while travelling, relative to the household's current routine. */
  exposure: Effect;
  emissions: Effect;
  notes: string[];
}

/** Rough per-person tailpipe-emission rank (lower = cleaner). Qualitative ordering only. */
const EMISSIONS_RANK: Record<string, number> = {
  work_from_home: 0,
  walk: 0,
  cycle: 0,
  metro: 1,
  bus: 2,
  two_wheeler: 3,
  car: 4,
  rideshare: 4,
};
/** Relative exposure to roadside pollution while travelling (lower = less exposed). Qualitative ordering only. */
const EXPOSURE_RANK: Record<string, number> = {
  work_from_home: 0,
  metro: 1,
  car: 1,
  rideshare: 1,
  bus: 2,
  walk: 3,
  cycle: 3,
  two_wheeler: 4,
};
const OUTDOOR_MODES = new Set(['walk', 'cycle', 'two_wheeler']);
const HIGH_AIR = new Set<Severity>(['unhealthy', 'very_unhealthy']);

function compare(a: number | undefined, b: number | undefined): Effect {
  if (a === undefined || b === undefined) return 'unknown';
  if (a < b) return 'lower';
  if (a > b) return 'higher';
  return 'similar';
}

/** Qualitative change in exposure and emissions from switching `current` to `candidate`. */
export function evaluateOption(
  current: CommuteMode,
  candidate: CommuteMode | 'work_from_home',
  severity: Severity,
): { exposure: Effect; emissions: Effect } {
  if (severity === 'unknown' || current === 'unknown') {
    // Emissions ordering does not depend on today's air, so it can still be reported.
    return { exposure: 'unknown', emissions: compare(EMISSIONS_RANK[candidate], EMISSIONS_RANK[current]) };
  }
  let exposure = compare(EXPOSURE_RANK[candidate], EXPOSURE_RANK[current]);
  // Exposure differences only matter once air is poor; on good days we do not claim a difference.
  if (severity === 'good') exposure = candidate === current ? 'similar' : 'unknown';
  if (HIGH_AIR.has(severity) && OUTDOOR_MODES.has(candidate) && !OUTDOOR_MODES.has(current))
    exposure = 'higher';
  return { exposure, emissions: compare(EMISSIONS_RANK[candidate], EMISSIONS_RANK[current]) };
}

/** Plain-language notes explaining a trade-off or why exposure cannot be compared. */
function optionNotes(
  current: CommuteMode,
  severity: Severity,
  exposure: Effect,
  emissions: Effect,
): string[] {
  const notes: string[] = [];
  if (exposure === 'higher' && emissions === 'lower') {
    notes.push('Cleaner for emissions, but you may be more exposed on poor-air days.');
  }
  if (exposure === 'lower' && emissions === 'higher')
    notes.push('Lowers your own exposure but adds emissions.');
  if (current === 'unknown') {
    notes.push('Add how you usually travel in My home to compare this with your routine.');
  } else if (exposure === 'unknown') {
    notes.push(
      severity === 'unknown'
        ? 'There is no verified air reading right now, so exposure cannot be compared.'
        : 'Air is good today, so differences in exposure are not meaningful.',
    );
  }
  return notes;
}

/** Compares each candidate routine with the current one. Exposure and emissions are kept separate. */
export function compareRoutines(input: {
  current: CommuteMode;
  candidates: Array<CommuteMode | 'work_from_home'>;
  severity: Severity;
  canWorkFromHome: boolean;
}): RoutineOption[] {
  const { current, severity } = input;
  return input.candidates
    .filter((c) => c !== current && (c !== 'work_from_home' || input.canWorkFromHome))
    .map((c) => {
      const { exposure, emissions } = evaluateOption(current, c, severity);
      return {
        id: c,
        label: LABELS[c] ?? c,
        mode: c,
        exposure,
        emissions,
        notes: optionNotes(current, severity, exposure, emissions),
      };
    });
}

const LABELS: Record<string, string> = {
  work_from_home: 'Work from home',
  walk: 'Walk',
  cycle: 'Cycle',
  bus: 'Bus',
  metro: 'Metro / train',
  car: 'Car',
  two_wheeler: 'Two-wheeler',
  rideshare: 'Rideshare',
};
