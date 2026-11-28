import type { AirQualityResult } from '../google/service.js';
import { overallSeverity, primaryIndex, type Severity } from '../google/severity.js';
import { compareRoutines, type CommuteMode, type Effect, type RoutineOption } from './impact.js';

export interface PlanHousehold {
  members: Array<{ ageGroup: string; needsExtraCaution: boolean }>;
  constraints: {
    commuteMode: string;
    canWorkFromHome: boolean;
    hasAirPurifier: boolean;
    hasPets: boolean;
    cookingFuel: string;
    budgetLevel: string;
    timeFlexibility: string;
  } | null;
}

export interface PlanItem {
  key: string;
  category: 'outdoor' | 'indoor' | 'commute' | 'protection';
  title: string;
  body: string;
  effort: 'low' | 'medium' | 'high';
  exposureEffect: Effect;
  emissionsEffect: Effect;
  /** `verified_data` items depend on the real snapshot; `general_guidance` items are education only. */
  basis: 'verified_data' | 'general_guidance';
}

export interface DailyPlan {
  status: AirQualityResult['status'];
  statusReason?: string;
  severity: Severity;
  headline: string;
  items: PlanItem[];
  indoorQuickWins: PlanItem[];
  routines: RoutineOption[];
  generalGuidanceNote: string;
}

const NOTE =
  'Items marked "general guidance" are educational and are not measurements or personal medical advice.';
const poor = (s: Severity) => s === 'unhealthy' || s === 'very_unhealthy';
const elevated = (s: Severity) => poor(s) || s === 'sensitive' || s === 'moderate';

function sensitiveMembers(h: PlanHousehold | null): boolean {
  return Boolean(
    h?.members.some((m) => m.needsExtraCaution || m.ageGroup === 'child' || m.ageGroup === 'older_adult'),
  );
}

type Constraints = PlanHousehold['constraints'];
type ItemFields = Omit<PlanItem, 'effort' | 'exposureEffect' | 'emissionsEffect'> & Partial<PlanItem>;

/** Most advice is low effort, lowers exposure and leaves emissions unchanged; items override what differs. */
const item = (fields: ItemFields): PlanItem => ({
  effort: 'low',
  exposureEffect: 'lower',
  emissionsEffect: 'similar',
  ...fields,
});

/** Indoor quick wins are general guidance and do not depend on today's reading. */
function indoorQuickWins(c: Constraints): PlanItem[] {
  const electric = c?.cookingFuel === 'induction' || c?.cookingFuel === 'electric';
  const wins = [
    item({
      key: 'ventilate-cooking',
      category: 'indoor',
      title: 'Use the exhaust fan when cooking',
      body: electric
        ? 'Even with electric or induction cooking, frying and searing release particles. Run the hood or an exhaust fan vented outdoors.'
        : 'Run the range hood or an exhaust fan vented outdoors while cooking and for a few minutes afterwards.',
      basis: 'general_guidance',
    }),
    item({
      key: 'no-indoor-smoke',
      category: 'indoor',
      title: 'Avoid burning things indoors',
      body: 'Skip incense, candles and smoking indoors, especially on days when outdoor air is poor.',
      emissionsEffect: 'lower',
      basis: 'general_guidance',
    }),
  ];
  if (!c?.hasAirPurifier) return wins;
  return [
    ...wins,
    item({
      key: 'run-purifier',
      category: 'indoor',
      title: 'Run your purifier in the room you use most',
      body: "Keep doors closed in that room and keep the filter within its replacement period. Effectiveness depends on room size and the purifier's CADR.",
      basis: 'general_guidance',
    }),
  ];
}

interface DayContext {
  category: string;
  flexible: boolean;
  sensitive: boolean;
  basis: PlanItem['basis'];
}

function poorDayItems({ category, flexible, basis }: DayContext): PlanItem[] {
  return [
    item({
      key: 'shift-outdoor',
      category: 'outdoor',
      title: 'Move strenuous activity indoors or to a cleaner time',
      body: `Provider category: ${category}. ${flexible ? 'You have some schedule flexibility, so check the forecast for a cleaner window.' : 'If your schedule is fixed, keep outdoor effort light.'}`,
      effort: flexible ? 'low' : 'medium',
      basis,
    }),
    item({
      key: 'close-windows',
      category: 'indoor',
      title: 'Keep windows closed during the worst hours',
      body: 'Ventilate briefly when outdoor readings are lower, and use your purifier or a filtered fan if you have one.',
      basis,
    }),
    item({
      key: 'respirator',
      category: 'protection',
      title: 'Consider a well-fitted respirator for unavoidable outdoor time',
      body: 'N95, FFP2 or KN95 respirators reduce particle intake only when they fit properly. Cloth masks give little protection from fine particles.',
      effort: 'medium',
      basis: 'general_guidance',
    }),
  ];
}

function elevatedDayItems({ sensitive, basis }: DayContext): PlanItem[] {
  return [
    item({
      key: 'ease-outdoor',
      category: 'outdoor',
      title: sensitive
        ? 'Take it easier outdoors today'
        : 'Outdoor activity is fine for most people; watch how you feel',
      body: sensitive
        ? 'Children, older adults and people who need extra caution are generally advised to reduce long or strenuous outdoor effort when air quality is not good.'
        : 'If you notice discomfort, shorten or slow down outdoor activity.',
      exposureEffect: sensitive ? 'lower' : 'similar',
      basis,
    }),
  ];
}

function goodDayItems({ basis }: DayContext): PlanItem[] {
  return [
    item({
      key: 'enjoy-outdoors',
      category: 'outdoor',
      title: 'Good day for outdoor activity and airing out the home',
      body: 'Open windows briefly to refresh indoor air, and consider walking or cycling for short trips, which also lowers emissions.',
      exposureEffect: 'similar',
      emissionsEffect: 'lower',
      basis,
    }),
  ];
}

function dayItems(severity: Severity, day: DayContext): PlanItem[] {
  if (poor(severity)) return poorDayItems(day);
  if (elevated(severity)) return elevatedDayItems(day);
  if (severity === 'good') return goodDayItems(day);
  return [];
}

const hasScheduleFlexibility = (c: Constraints) =>
  c !== null && c.timeFlexibility !== 'fixed' && c.timeFlexibility !== 'unknown';

function noDataPlan(aq: AirQualityResult, quick: PlanItem[]): DailyPlan {
  return {
    status: aq.status,
    statusReason: aq.reason,
    severity: 'unknown',
    items: [],
    indoorQuickWins: quick,
    routines: [],
    headline:
      aq.status === 'not_configured'
        ? 'Air-quality data is not configured, so no readings or day-specific advice are shown.'
        : 'Live air-quality data is unavailable, so only general guidance is shown.',
    generalGuidanceNote: NOTE,
  };
}

function headlineFor(aq: AirQualityResult, idx: ReturnType<typeof primaryIndex>): string {
  if (aq.status === 'stale') return 'Showing the last real reading; the provider is currently unreachable.';
  const detail = idx ? ` (${idx.displayName} ${idx.aqi})` : '';
  return `Provider category: ${idx?.category ?? 'unknown'}${detail}.`;
}

/**
 * Builds today's plan from the verified reading and the household's needs. Without real data only general
 * guidance is returned; day-specific advice always rests on the snapshot.
 */
export function buildDailyPlan(aq: AirQualityResult, household: PlanHousehold | null): DailyPlan {
  const c = household?.constraints ?? null;
  const quick = indoorQuickWins(c);
  if (!aq.snapshot) return noDataPlan(aq, quick);

  const severity = overallSeverity(aq.snapshot);
  const idx = primaryIndex(aq.snapshot);
  const items = dayItems(severity, {
    category: idx?.category ?? 'poor',
    flexible: hasScheduleFlexibility(c),
    sensitive: sensitiveMembers(household),
    basis: 'verified_data',
  });
  const routines = compareRoutines({
    current: (c?.commuteMode ?? 'unknown') as CommuteMode,
    severity,
    canWorkFromHome: Boolean(c?.canWorkFromHome),
    candidates: ['work_from_home', 'walk', 'cycle', 'bus', 'metro', 'car', 'two_wheeler'],
  });
  return {
    status: aq.status,
    statusReason: aq.reason,
    severity,
    items,
    indoorQuickWins: quick,
    routines,
    headline: headlineFor(aq, idx),
    generalGuidanceNote: NOTE,
  };
}
