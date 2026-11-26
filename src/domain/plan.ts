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

export function buildDailyPlan(aq: AirQualityResult, household: PlanHousehold | null): DailyPlan {
  const c = household?.constraints ?? null;
  const items: PlanItem[] = [];
  const quick: PlanItem[] = [];
  const hasData = aq.snapshot !== null;
  const severity = aq.snapshot ? overallSeverity(aq.snapshot) : 'unknown';
  const sensitive = sensitiveMembers(household);
  const basis: PlanItem['basis'] = hasData ? 'verified_data' : 'general_guidance';

  // Indoor quick wins are general guidance regardless of today's data.
  quick.push({
    key: 'ventilate-cooking',
    category: 'indoor',
    title: 'Use the exhaust fan when cooking',
    body:
      c?.cookingFuel === 'induction' || c?.cookingFuel === 'electric'
        ? 'Even with electric or induction cooking, frying and searing release particles. Run the hood or an exhaust fan vented outdoors.'
        : 'Run the range hood or an exhaust fan vented outdoors while cooking and for a few minutes afterwards.',
    effort: 'low',
    exposureEffect: 'lower',
    emissionsEffect: 'similar',
    basis: 'general_guidance',
  });
  quick.push({
    key: 'no-indoor-smoke',
    category: 'indoor',
    title: 'Avoid burning things indoors',
    body: 'Skip incense, candles and smoking indoors, especially on days when outdoor air is poor.',
    effort: 'low',
    exposureEffect: 'lower',
    emissionsEffect: 'lower',
    basis: 'general_guidance',
  });
  if (c?.hasAirPurifier) {
    quick.push({
      key: 'run-purifier',
      category: 'indoor',
      title: 'Run your purifier in the room you use most',
      body: "Keep doors closed in that room and keep the filter within its replacement period. Effectiveness depends on room size and the purifier's CADR.",
      effort: 'low',
      exposureEffect: 'lower',
      emissionsEffect: 'similar',
      basis: 'general_guidance',
    });
  }

  if (!hasData) {
    return {
      status: aq.status,
      statusReason: aq.reason,
      severity,
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

  const idx = primaryIndex(aq.snapshot!);
  const timing = Boolean(c && c.timeFlexibility !== 'fixed' && c.timeFlexibility !== 'unknown');

  if (poor(severity)) {
    items.push({
      key: 'shift-outdoor',
      category: 'outdoor',
      title: 'Move strenuous activity indoors or to a cleaner time',
      body: `Provider category: ${idx?.category ?? 'poor'}. ${timing ? 'You have some schedule flexibility, so check the forecast for a cleaner window.' : 'If your schedule is fixed, keep outdoor effort light.'}`,
      effort: timing ? 'low' : 'medium',
      exposureEffect: 'lower',
      emissionsEffect: 'similar',
      basis,
    });
    items.push({
      key: 'close-windows',
      category: 'indoor',
      title: 'Keep windows closed during the worst hours',
      body: 'Ventilate briefly when outdoor readings are lower, and use your purifier or a filtered fan if you have one.',
      effort: 'low',
      exposureEffect: 'lower',
      emissionsEffect: 'similar',
      basis,
    });
    items.push({
      key: 'respirator',
      category: 'protection',
      title: 'Consider a well-fitted respirator for unavoidable outdoor time',
      body: 'N95, FFP2 or KN95 respirators reduce particle intake only when they fit properly. Cloth masks give little protection from fine particles.',
      effort: 'medium',
      exposureEffect: 'lower',
      emissionsEffect: 'similar',
      basis: 'general_guidance',
    });
  } else if (elevated(severity)) {
    items.push({
      key: 'ease-outdoor',
      category: 'outdoor',
      title: sensitive
        ? 'Take it easier outdoors today'
        : 'Outdoor activity is fine for most people; watch how you feel',
      body: sensitive
        ? 'Children, older adults and people who need extra caution are generally advised to reduce long or strenuous outdoor effort when air quality is not good.'
        : 'If you notice discomfort, shorten or slow down outdoor activity.',
      effort: 'low',
      exposureEffect: sensitive ? 'lower' : 'similar',
      emissionsEffect: 'similar',
      basis,
    });
  } else if (severity === 'good') {
    items.push({
      key: 'enjoy-outdoors',
      category: 'outdoor',
      title: 'Good day for outdoor activity and airing out the home',
      body: 'Open windows briefly to refresh indoor air, and consider walking or cycling for short trips, which also lowers emissions.',
      effort: 'low',
      exposureEffect: 'similar',
      emissionsEffect: 'lower',
      basis,
    });
  }

  const current = (c?.commuteMode ?? 'unknown') as CommuteMode;
  const routines = compareRoutines({
    current,
    severity,
    canWorkFromHome: Boolean(c?.canWorkFromHome),
    candidates: ['work_from_home', 'walk', 'cycle', 'bus', 'metro', 'car', 'two_wheeler'],
  });

  const stale = aq.status === 'stale';
  return {
    status: aq.status,
    statusReason: aq.reason,
    severity,
    items,
    indoorQuickWins: quick,
    routines,
    headline: stale
      ? 'Showing the last real reading; the provider is currently unreachable.'
      : `Provider category: ${idx?.category ?? 'unknown'}${idx ? ` (${idx.displayName} ${idx.aqi})` : ''}.`,
    generalGuidanceNote: NOTE,
  };
}
