import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compareRoutines, evaluateOption } from '../src/domain/impact.js';
import { buildDailyPlan } from '../src/domain/plan.js';
import { normalizeCurrent } from '../src/google/normalize.js';
import { overallSeverity, severityOf } from '../src/google/severity.js';
import { currentBody } from './helpers/google-fixtures.js';
import type { AirQualityResult } from '../src/google/service.js';

describe('exposure and emissions are computed separately', () => {
  it('car on a poor day: lower exposure than walking but higher emissions', () => {
    const walk = evaluateOption('car', 'walk', 'unhealthy');
    assert.equal(walk.emissions, 'lower');
    assert.equal(walk.exposure, 'higher');
    const car = evaluateOption('walk', 'car', 'unhealthy');
    assert.equal(car.emissions, 'higher');
    assert.equal(car.exposure, 'lower');
  });
  it('working from home lowers both', () => {
    assert.deepEqual(evaluateOption('car', 'work_from_home', 'unhealthy'), {
      exposure: 'lower',
      emissions: 'lower',
    });
  });
  it('does not claim exposure differences on good days or when data is missing', () => {
    assert.equal(evaluateOption('car', 'walk', 'good').exposure, 'unknown');
    const noData = evaluateOption('car', 'walk', 'unknown');
    assert.equal(noData.exposure, 'unknown');
    assert.equal(noData.emissions, 'lower', 'emissions ordering does not need air data');
  });
  it('produces a note for trade-offs and skips unavailable options', () => {
    const opts = compareRoutines({
      current: 'car',
      candidates: ['walk', 'work_from_home', 'car'],
      severity: 'unhealthy',
      canWorkFromHome: false,
    });
    assert.deepEqual(
      opts.map((o) => o.id),
      ['walk'],
    );
    assert.match(opts[0]!.notes.join(' '), /more exposed/);
  });
});

describe('severity mapping respects index direction', () => {
  it('uaqi is higher = better; local indexes are higher = worse', () => {
    assert.equal(severityOf({ code: 'uaqi', displayName: '', aqi: 90, category: '' }), 'good');
    assert.equal(severityOf({ code: 'uaqi', displayName: '', aqi: 10, category: '' }), 'very_unhealthy');
    assert.equal(severityOf({ code: 'usa_epa', displayName: '', aqi: 160, category: '' }), 'unhealthy');
    assert.equal(severityOf({ code: 'ind_cpcb', displayName: '', aqi: 350, category: '' }), 'very_unhealthy');
    assert.equal(severityOf({ code: 'mystery', displayName: '', aqi: 5, category: '' }), 'unknown');
  });
});

const result = (status: AirQualityResult['status'], snap = true): AirQualityResult => ({
  status,
  snapshot: snap
    ? normalizeCurrent(currentBody({ indexes: [{ code: 'usa_epa', aqi: 170, category: 'Unhealthy' }] }), {
        latitude: 1,
        longitude: 1,
        fetchedAt: new Date(),
      })
    : null,
  reason: snap ? undefined : 'unavailable',
});
const household = {
  members: [{ ageGroup: 'child', needsExtraCaution: false }],
  constraints: {
    commuteMode: 'car',
    canWorkFromHome: true,
    hasAirPurifier: true,
    hasPets: false,
    cookingFuel: 'lpg',
    budgetLevel: 'low',
    timeFlexibility: 'some',
  },
};

describe('daily plan', () => {
  it('uses verified data when available and labels guidance honestly', () => {
    const plan = buildDailyPlan(result('fresh'), household);
    assert.equal(plan.severity, 'unhealthy');
    assert.ok(plan.items.some((i) => i.key === 'shift-outdoor' && i.basis === 'verified_data'));
    assert.ok(plan.items.some((i) => i.key === 'respirator' && i.basis === 'general_guidance'));
    assert.ok(plan.indoorQuickWins.every((i) => i.basis === 'general_guidance'));
    assert.ok(plan.indoorQuickWins.some((i) => i.key === 'run-purifier'));
    assert.match(plan.generalGuidanceNote, /general guidance/);
    assert.ok(
      plan.routines.some(
        (r) => r.id === 'work_from_home' && r.exposure === 'lower' && r.emissions === 'lower',
      ),
    );
  });
  it('without data: no day-specific items, no routines, only general guidance and an explicit headline', () => {
    const plan = buildDailyPlan(result('unavailable', false), household);
    assert.equal(plan.items.length, 0);
    assert.equal(plan.routines.length, 0);
    assert.match(plan.headline, /unavailable/i);
    assert.ok(
      plan.indoorQuickWins.length > 0 && plan.indoorQuickWins.every((i) => i.basis === 'general_guidance'),
    );
    const nc = buildDailyPlan({ status: 'not_configured', snapshot: null }, null);
    assert.match(nc.headline, /not configured/i);
  });
  it('flags stale data in the headline', () => {
    assert.match(buildDailyPlan(result('stale'), household).headline, /last real reading/i);
  });
  it('overallSeverity prefers the regional index', () => {
    assert.equal(overallSeverity(result('fresh').snapshot!), 'unhealthy');
  });
});
