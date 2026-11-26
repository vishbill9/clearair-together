import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkAssistantOutput } from '../src/ai/safety.js';
import { assistantOutputSchema, type AssistantOutput } from '../src/ai/schema.js';
import { emergencyNumber, emergencyResponse, isEmergencyMessage } from '../src/ai/emergency.js';
import { extractJson } from '../src/ai/assistant.js';
import { normalizeCurrent } from '../src/google/normalize.js';
import { currentBody } from './helpers/google-fixtures.js';

const snapshot = normalizeCurrent(currentBody(), { latitude: 28.6, longitude: 77.2, fetchedAt: new Date() }); // AQIs 42 and 188
const good = (over: Partial<AssistantOutput> = {}): AssistantOutput => ({
  directAnswer: 'Consider moving a long run indoors today and keep windows closed during peak hours.',
  recommendedActions: [
    { title: 'Shift exercise', detail: 'Move strenuous effort to a cleaner time or indoors.', effort: 'low' },
  ],
  effortLevel: 'low',
  rationale: 'Readings are elevated, so reducing strenuous outdoor effort lowers exposure.',
  feasibleAlternative: 'A short, easy walk is a lighter option.',
  exposureOpportunity: 'lower',
  emissionsOpportunity: 'similar',
  assumptions: ['You can reschedule your run.'],
  safetyNotice: 'This is general guidance, not medical advice.',
  sources: [{ id: 'g-timing' }],
  uncertainty: 'Air quality can change within hours.',
  ...over,
});
const rules = (o: AssistantOutput, snap: typeof snapshot | null = snapshot) =>
  checkAssistantOutput(o, { snapshot: snap }).map((v) => v.rule);

describe('output schema', () => {
  it('accepts a valid object', () => assert.equal(assistantOutputSchema.safeParse(good()).success, true));
  it('rejects unknown fields, bad enums, overlong and missing fields', () => {
    assert.equal(assistantOutputSchema.safeParse({ ...good(), extra: 1 }).success, false);
    assert.equal(assistantOutputSchema.safeParse({ ...good(), exposureOpportunity: 'maybe' }).success, false);
    assert.equal(
      assistantOutputSchema.safeParse({ ...good(), directAnswer: 'x'.repeat(2000) }).success,
      false,
    );
    const { uncertainty: _u, ...missing } = good();
    assert.equal(assistantOutputSchema.safeParse(missing).success, false);
  });
  it('extracts JSON from fenced model output and rejects prose', () => {
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.throws(() => extractJson('no json here'));
  });
});

describe('deterministic safety policy', () => {
  it('passes a compliant answer', () => assert.deepEqual(rules(good()), []));

  it('blocks diagnosis', () => {
    assert.ok(
      rules(good({ directAnswer: 'You probably have asthma, so avoid going out.' })).includes('diagnosis'),
    );
    assert.ok(rules(good({ rationale: 'That sounds like bronchitis.' })).includes('diagnosis'));
  });
  it('blocks medication changes and dosing', () => {
    assert.ok(
      rules(good({ directAnswer: 'Double your inhaler dose on smoggy days.' })).includes('medication'),
    );
    assert.ok(rules(good({ directAnswer: 'Take 200 mg of an antihistamine.' })).includes('medication'));
  });
  it('blocks unsupported certainty and risk-elimination claims', () => {
    assert.ok(
      rules(good({ directAnswer: 'A purifier completely eliminates the risk.' })).includes('certainty'),
    );
    assert.ok(rules(good({ directAnswer: 'You will be 100% safe indoors.' })).includes('certainty'));
    assert.ok(rules(good({ rationale: 'This guarantees no harm.' })).includes('certainty'));
  });
  it('blocks unsafe indoor-air advice', () => {
    assert.ok(
      rules(good({ directAnswer: 'Run an ozone generator to clean the room.' })).includes('unsafe_indoor'),
    );
    assert.ok(
      rules(good({ directAnswer: 'Light incense indoors to mask the smell.' })).includes('unsafe_indoor'),
    );
    assert.ok(
      rules(good({ directAnswer: 'Tape over all the vents and the chimney.' })).includes('unsafe_indoor'),
    );
    assert.ok(
      !rules(
        good({ directAnswer: 'Do not use an ozone generator; avoid ozone-producing devices.' }),
      ).includes('unsafe_indoor'),
    );
  });
  it('blocks fabricated AQI values and allows only verified ones', () => {
    assert.ok(rules(good({ directAnswer: 'The AQI is 312 right now.' })).includes('fabricated_aqi'));
    assert.ok(rules(good({ directAnswer: 'Universal AQI is 42 right now.' })).length === 0);
    assert.ok(rules(good({ directAnswer: 'Your CPCB AQI of 188 is moderate.' })).length === 0);
  });
  it('blocks any AQI number when there is no verified snapshot', () => {
    assert.ok(rules(good({ directAnswer: 'The AQI is 42.' }), null).includes('fabricated_aqi'));
    assert.ok(
      rules(good({ directAnswer: 'Right now the air is good.' }), null).includes('fabricated_conditions'),
    );
  });
  it('blocks fabricated citations, URLs, phone numbers and local services', () => {
    assert.ok(rules(good({ sources: [{ id: 'made-up-study' }] })).includes('fabricated_citation'));
    assert.ok(
      rules(good({ rationale: 'See https://example.com/study for details.' })).includes(
        'fabricated_citation',
      ),
    );
    assert.ok(rules(good({ directAnswer: 'Call +91 98765 43210 for help.' })).includes('fabricated_service'));
    assert.ok(
      rules(good({ directAnswer: 'Visit the Sunrise Wellness Clinic nearby.' })).includes(
        'fabricated_service',
      ),
    );
  });
  it('blocks presenting as a medical or emergency service', () => {
    assert.ok(rules(good({ directAnswer: 'I am a doctor and advise rest.' })).includes('impersonation'));
  });
});

describe('emergency handling', () => {
  it('detects urgent symptom language', () => {
    for (const m of [
      "I can't breathe properly",
      'chest pain after smoke exposure',
      'my child fainted',
      'having an asthma attack',
      'difficulty breathing',
    ]) {
      assert.equal(isEmergencyMessage(m), true, m);
    }
    assert.equal(isEmergencyMessage('Should I run outside tomorrow?'), false);
  });
  it('uses known local numbers and never invents one', () => {
    assert.equal(emergencyNumber('us'), '911');
    assert.equal(emergencyNumber('IN'), '112');
    assert.equal(emergencyNumber('ZZ'), null);
    const r = emergencyResponse('ZZ');
    assert.equal(r.emergencyNumber, null);
    assert.match(r.message, /local emergency number/);
    assert.match(r.message, /not an emergency service/);
  });
});
