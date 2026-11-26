import { $, h, clear, show } from './dom.js';
import { api, ApiError } from './api.js';
import { startVoice } from './voice.js';

const state = { loc: null, aq: null, householdId: null, config: null, challengeId: null, voice: null };
const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* storage unavailable */
    }
  },
};

const STATUS_TEXT = {
  fresh: 'Live',
  cached: 'Recent (cached)',
  stale: 'Stale: provider unreachable',
  unavailable: 'Unavailable',
  not_configured: 'Not configured',
};
const SEVERITY_POS = { good: 10, moderate: 30, sensitive: 50, unhealthy: 70, very_unhealthy: 90 };
const EFFECT_TEXT = { lower: 'Lower', similar: 'About the same', higher: 'Higher', unknown: 'Unknown' };
const SOURCE_TITLES = {
  'epa-aqi-basics': 'US EPA AirNow: AQI basics',
  'who-air-pollution': 'WHO: Air pollution',
  'g-timing': 'General guidance: timing outdoor activity',
  'g-filtration': 'General guidance: indoor air cleaning',
  'g-source-control': 'General guidance: reducing indoor sources',
  'g-masks': 'General guidance: respirators',
  'g-commute': 'General guidance: commuting choices',
};

const fmt = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const errText = (e) => (e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
const setMsg = (el, text, isNotice = true) => {
  el.textContent = text || '';
  show(el, Boolean(text));
  if (isNotice) el.classList.add('notice');
};

async function loadConfig() {
  try {
    state.config = await api('GET', '/api/v1/config');
  } catch (e) {
    const b = $('config-banner');
    b.textContent = errText(e);
    show(b);
    return;
  }
  const i = state.config.integrations;
  const missing = [];
  if (!i.googleAirQuality)
    missing.push('Air-quality data is not configured on this server, so no readings are shown.');
  if (!i.assistant) missing.push('The assistant is not configured. Urgent-symptom guidance still works.');
  if (!i.database) missing.push('The database is not configured, so households and plans cannot be saved.');
  if (missing.length) {
    const b = $('config-banner');
    clear(b);
    b.append(
      h('strong', {}, 'Some features are not configured'),
      h(
        'ul',
        {},
        missing.map((m) => h('li', {}, m)),
      ),
    );
    show(b);
  }
  show($('camera-block'), i.vision);
  show($('voice-btn'), i.live && Boolean(navigator.mediaDevices?.getUserMedia));
  if (!i.assistant) $('chat-send').disabled = false; // still lets emergency wording through
}

// ---- Air quality ------------------------------------------------------------------------------
function renderStatus(d) {
  state.aq = d;
  show($('status-empty'), false);
  show($('status'));
  const s = d.snapshot;
  const col = $('column');
  col.classList.toggle('none', !s || d.severity === 'unknown');
  $('column-marker').style.left = `${SEVERITY_POS[d.severity] ?? 50}%`;
  col.setAttribute(
    'aria-label',
    s ? `Air quality category: ${primary(s)?.category ?? 'unknown'}` : 'No air-quality reading available',
  );

  const p = s && primary(s);
  $('status-headline').textContent = p
    ? `${p.category}`
    : d.status === 'not_configured'
      ? 'Air-quality data is not configured'
      : 'No reading available';
  setMsg($('status-reason'), d.reason);
  const fb = $('fresh-badge');
  fb.textContent = STATUS_TEXT[d.status] ?? d.status;
  fb.dataset.s = d.status;
  $('source-badge').textContent = s ? 'Source: Google Air Quality API' : 'No data source reached';

  const prov = $('prov');
  clear(prov);
  if (s) {
    const rows = [
      ['Observed', `${fmt(s.observedAt)} (${s.observedAt})`],
      ['Fetched', `${fmt(s.fetchedAt)} (${s.fetchedAt})`],
      ['Region', s.regionCode ?? 'Not provided'],
      ['Source', s.source],
    ];
    for (const [k, v] of rows) prov.append(h('dt', {}, k), h('dd', {}, v));
  }
  const idx = $('indexes');
  clear(idx);
  (s?.indexes ?? []).forEach((i) =>
    idx.append(
      h(
        'li',
        {},
        `${i.displayName}: ${i.aqi} (${i.category})${i.code === 'uaqi' ? '. On this scale a higher number is better.' : ''}`,
      ),
    ),
  );
  if (!s) idx.append(h('li', {}, 'No index values to show.'));
  const dom = p?.dominantPollutant;
  $('dominant').textContent = dom ? `Dominant pollutant: ${dom.toUpperCase()}` : '';
  const tb = $('pollutants').tBodies[0];
  clear(tb);
  (s?.pollutants ?? []).forEach((x) =>
    tb.append(h('tr', {}, h('th', { scope: 'row' }, x.displayName), h('td', {}, `${x.value} ${x.units}`))),
  );
  if (!s?.pollutants?.length) tb.append(h('tr', {}, h('td', { colspan: '2' }, 'No pollutant data.')));
  const ph = $('provider-health');
  clear(ph);
  const hr = s?.healthRecommendations ?? {};
  Object.entries(hr).forEach(([k, v]) => ph.append(h('li', {}, h('strong', {}, `${label(k)}: `), v)));
  if (!Object.keys(hr).length) ph.append(h('li', {}, 'The provider did not include health notes.'));
  syncButtons();
}
const primary = (s) => s.indexes.find((i) => i.code !== 'uaqi') ?? s.indexes[0];
const label = (k) => k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

async function checkAir() {
  const lat = Number($('lat').value),
    lng = Number($('lng').value);
  const err = $('loc-error');
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180 ||
    $('lat').value.trim() === '' ||
    $('lng').value.trim() === ''
  ) {
    err.textContent = 'Enter a latitude between -90 and 90 and a longitude between -180 and 180.';
    show(err);
    return;
  }
  show(err, false);
  state.loc = { lat, lng };
  $('status-panel').setAttribute('aria-busy', 'true');
  try {
    renderStatus(
      await api('GET', `/api/v1/air-quality?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`),
    );
  } catch (e) {
    err.textContent = errText(e);
    show(err);
  } finally {
    $('status-panel').removeAttribute('aria-busy');
  }
}

// ---- Household --------------------------------------------------------------------------------
async function saveHousehold(ev) {
  ev.preventDefault();
  const msg = $('house-msg');
  if (!state.loc) {
    msg.textContent = 'Set your location first.';
    return;
  }
  const members = [];
  if ($('m-child').checked)
    members.push({ label: 'Child', ageGroup: 'child', needsExtraCaution: $('m-caution').checked });
  if ($('m-older').checked)
    members.push({
      label: 'Older adult',
      ageGroup: 'older_adult',
      needsExtraCaution: $('m-caution').checked,
    });
  if (!members.length && $('m-caution').checked)
    members.push({ label: 'Adult', ageGroup: 'adult', needsExtraCaution: true });
  const body = {
    name: $('h-name').value.trim() || 'Home',
    lat: state.loc.lat,
    lng: state.loc.lng,
    members,
    constraints: {
      commuteMode: $('c-commute').value,
      cookingFuel: $('c-fuel').value,
      timeFlexibility: $('c-time').value,
      budgetLevel: $('c-budget').value,
      canWorkFromHome: $('c-wfh').checked,
      hasAirPurifier: $('c-purifier').checked,
      hasPets: $('c-pets').checked,
    },
  };
  $('house-save').disabled = true;
  try {
    const d = await api('POST', '/api/v1/households', body);
    state.householdId = d.id;
    store.set('ca_household', d.id);
    msg.textContent = 'Household saved.';
    syncButtons();
    void refreshIndoor();
  } catch (e) {
    msg.textContent = errText(e);
  } finally {
    $('house-save').disabled = false;
  }
}

function syncButtons() {
  const ready = Boolean(state.householdId);
  $('plan-btn').disabled = !ready;
  $('compare-btn').disabled = !ready;
  $('plan-hint').textContent = ready
    ? 'Plans use your household and the latest verified air-quality data.'
    : 'Save your household first.';
  $('visual-btn').disabled = !(ready && $('img').files?.length);
}

// ---- Plan -------------------------------------------------------------------------------------
const effortText = { low: 'Low effort', medium: 'Medium effort', high: 'High effort' };
function planItem(i) {
  const fb = h('div', { class: 'fb' });
  const note = h('span', { class: 'hint', role: 'status' });
  if (i.id)
    for (const [t, text] of [
      ['helpful', 'Helpful'],
      ['not_helpful', 'Not helpful'],
      ['done', 'Done'],
      ['not_feasible', 'Can’t do this'],
    ]) {
      fb.append(
        h(
          'button',
          {
            type: 'button',
            class: 'secondary',
            onclick: async () => {
              try {
                await api('POST', `/api/v1/recommendations/${i.id}/feedback`, { eventType: t });
                note.textContent = 'Saved.';
              } catch (e) {
                note.textContent = errText(e);
              }
            },
          },
          text,
        ),
      );
    }
  return h(
    'li',
    {},
    h('h4', {}, i.title),
    h('p', {}, i.body),
    h(
      'div',
      { class: 'meta' },
      h('span', {}, effortText[i.effort]),
      h('span', {}, i.basis === 'general_guidance' ? 'General guidance' : 'Based on verified data'),
      h(
        'span',
        {},
        'Exposure: ',
        h('span', { class: 'eff', dataset: { e: i.exposureEffect } }, EFFECT_TEXT[i.exposureEffect]),
      ),
      h(
        'span',
        {},
        'Emissions: ',
        h('span', { class: 'eff', dataset: { e: i.emissionsEffect } }, EFFECT_TEXT[i.emissionsEffect]),
      ),
    ),
    fb,
    note,
  );
}
async function buildPlan() {
  $('plan-btn').disabled = true;
  try {
    const p = await api('POST', `/api/v1/households/${state.householdId}/daily-plan`, {});
    show($('plan'));
    $('plan-headline').textContent = p.headline;
    setMsg($('plan-reason'), p.statusReason);
    const a = $('plan-items');
    clear(a);
    p.items.forEach((i) => a.append(planItem(i)));
    if (!p.items.length)
      a.append(
        h('li', {}, 'No day-specific actions are shown because there is no verified air-quality reading.'),
      );
    const q = $('quick-wins');
    clear(q);
    p.indoorQuickWins.forEach((i) => q.append(planItem(i)));
    $('plan-note').textContent = p.generalGuidanceNote;
  } catch (e) {
    show($('plan'));
    $('plan-headline').textContent = errText(e);
  } finally {
    syncButtons();
  }
}

async function compare() {
  const picks = [...document.querySelectorAll('#cand input:checked')].map((i) => i.value);
  const msg = $('compare-msg'),
    tbl = $('compare-tbl');
  if (!picks.length) {
    setMsg(msg, 'Choose at least one option.');
    return;
  }
  try {
    const d = await api('POST', '/api/v1/scenarios/compare', {
      householdId: state.householdId,
      candidates: picks,
    });
    const tb = tbl.tBodies[0];
    clear(tb);
    d.options.forEach((o) =>
      tb.append(
        h(
          'tr',
          {},
          h('th', { scope: 'row' }, o.label),
          h(
            'td',
            { 'data-label': 'Your exposure' },
            h('span', { class: 'eff', dataset: { e: o.exposure } }, EFFECT_TEXT[o.exposure]),
          ),
          h(
            'td',
            { 'data-label': 'Emissions' },
            h('span', { class: 'eff', dataset: { e: o.emissions } }, EFFECT_TEXT[o.emissions]),
          ),
          h('td', { 'data-label': 'Note' }, o.notes.join(' ')),
        ),
      ),
    );
    show(tbl, d.options.length > 0);
    setMsg(
      msg,
      d.options.length
        ? `${d.note}${d.reason ? ' ' + d.reason : ''}`
        : 'Nothing to compare: these options match your usual commute or are not available to you.',
    );
  } catch (e) {
    setMsg(msg, errText(e));
  }
}

// ---- Indoor -----------------------------------------------------------------------------------
async function refreshIndoor() {
  if (!state.householdId) return;
  try {
    const d = await api('GET', `/api/v1/indoor/status?householdId=${state.householdId}`);
    const box = $('indoor-status');
    clear(box);
    box.classList.toggle('empty', d.status !== 'measured');
    box.append(h('p', {}, d.message));
    d.readings.forEach((r) =>
      box.append(
        h(
          'p',
          {},
          `${r.pollutant.toUpperCase()}: ${r.value} ${r.unit === 'ug/m3' ? 'µg/m³' : r.unit} at ${fmt(r.measuredAt)}${r.reference ? `. ${r.reference.relation === 'above' ? 'Above' : 'At or below'} the ${r.reference.guideline}.` : ''}`,
        ),
      ),
    );
  } catch {
    /* leave default text */
  }
}

async function submitVisual(ev) {
  ev.preventDefault();
  const f = $('img').files[0];
  const msg = $('visual-msg');
  const out = $('visual-out');
  if (!f) return;
  const fd = new FormData();
  fd.append('householdId', state.householdId);
  fd.append('storeImage', $('v-store').checked ? 'true' : 'false');
  fd.append('consent', $('v-store').checked ? 'true' : 'false');
  for (const [id, k] of [
    ['v-area', 'roomAreaM2'],
    ['v-height', 'ceilingHeightM'],
    ['v-cadr', 'cadrM3h'],
  ])
    if ($(id).value.trim()) fd.append(k, $(id).value.trim());
  fd.append('image', f);
  $('visual-btn').disabled = true;
  setMsg(msg, 'Checking the photo…');
  try {
    const d = await api('POST', '/api/v1/indoor/visual-assessment', undefined, { form: fd });
    show(msg, false);
    clear(out);
    show(out);
    const list = (t, xs) =>
      xs.length
        ? [
            h('h4', {}, t),
            h(
              'ul',
              {},
              xs.map((x) => h('li', {}, x)),
            ),
          ]
        : [];
    out.append(
      h('p', { class: 'disclaimer' }, d.disclaimer),
      h('p', {}, `Confidence: ${d.confidence}`),
      ...list('What the photo shows', d.observations),
      ...list(
        'Possible sources',
        d.possibleSources.map((s) => `${s.source}: ${s.basis}`),
      ),
      ...list('Ventilation', d.ventilationNotes),
      ...list('Suggested checks', d.suggestedChecks),
      h('h4', {}, 'Plants (optional)'),
      h('p', {}, `${d.plants.guidance} ${d.plants.safetyCheck}`),
      h('h4', {}, 'Purifier'),
      h('p', {}, d.purifier.message),
      ...list('Limits', d.limitations),
      h(
        'p',
        { class: 'hint' },
        d.stored
          ? 'This photo is stored encrypted. It is deleted after the retention period.'
          : 'This photo was not stored.',
      ),
    );
    if (d.imageId)
      out.append(
        h(
          'button',
          {
            type: 'button',
            class: 'secondary',
            onclick: async (e) => {
              try {
                await api('DELETE', `/api/v1/indoor/images/${d.imageId}`);
                e.target.textContent = 'Deleted';
                e.target.disabled = true;
              } catch (er) {
                setMsg(msg, errText(er));
              }
            },
          },
          'Delete stored photo',
        ),
      );
  } catch (e) {
    show(out, false);
    setMsg(msg, errText(e));
  } finally {
    syncButtons();
  }
}

// ---- Assistant --------------------------------------------------------------------------------
function addMsg(kind, ...nodes) {
  const m = h('div', { class: `msg ${kind}` }, nodes);
  const c = $('chat');
  c.append(m);
  c.scrollTop = c.scrollHeight;
  return m;
}
function renderAnswer(d) {
  if (d.kind === 'emergency') {
    addMsg('bot emergency', h('h4', {}, 'This may be urgent'), h('p', {}, d.response.message));
    return;
  }
  const o = d.output;
  const parts = [];
  if (d.blocked)
    parts.push(
      h(
        'p',
        { class: 'notice' },
        'The generated answer did not pass safety checks, so this general reply is shown instead.',
      ),
    );
  parts.push(h('p', {}, o.directAnswer));
  if (o.recommendedActions.length)
    parts.push(
      h('h4', {}, 'What you can do'),
      h(
        'ul',
        {},
        o.recommendedActions.map((a) =>
          h('li', {}, h('strong', {}, `${a.title}. `), a.detail, ` (${effortText[a.effort]})`),
        ),
      ),
    );
  if (o.rationale) parts.push(h('h4', {}, 'Why'), h('p', {}, o.rationale));
  if (o.feasibleAlternative) parts.push(h('h4', {}, 'If that is hard'), h('p', {}, o.feasibleAlternative));
  parts.push(
    h(
      'p',
      { class: 'meta' },
      h(
        'span',
        {},
        'Exposure: ',
        h(
          'span',
          { class: 'eff', dataset: { e: o.exposureOpportunity } },
          EFFECT_TEXT[o.exposureOpportunity],
        ),
      ),
      h(
        'span',
        {},
        'Emissions: ',
        h(
          'span',
          { class: 'eff', dataset: { e: o.emissionsOpportunity } },
          EFFECT_TEXT[o.emissionsOpportunity],
        ),
      ),
    ),
  );
  if (o.assumptions.length)
    parts.push(
      h('h4', {}, 'Assumptions'),
      h(
        'ul',
        {},
        o.assumptions.map((x) => h('li', {}, x)),
      ),
    );
  if (o.safetyNotice) parts.push(h('p', { class: 'notice' }, o.safetyNotice));
  parts.push(h('p', { class: 'hint' }, `Uncertainty: ${o.uncertainty}`));
  if (o.sources.length)
    parts.push(
      h(
        'p',
        { class: 'hint' },
        'Sources (general guidance): ',
        o.sources.map((s) => SOURCE_TITLES[s.id] ?? s.id).join('; '),
      ),
    );
  parts.push(
    h(
      'p',
      { class: 'hint' },
      `Air-quality data status: ${STATUS_TEXT[d.airQualityStatus] ?? d.airQualityStatus}`,
    ),
  );
  addMsg('bot', parts);
}
async function ask(ev) {
  ev.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text) return;
  addMsg('user', h('p', {}, text));
  $('chat-input').value = '';
  const body = { message: text };
  if (state.householdId) body.householdId = state.householdId;
  else if (state.loc) {
    body.lat = state.loc.lat;
    body.lng = state.loc.lng;
  }
  $('chat-send').disabled = true;
  const pending = addMsg('bot', h('p', { class: 'hint' }, 'Thinking…'));
  try {
    renderAnswer(await api('POST', '/api/v1/assistant/messages', body));
  } catch (e) {
    addMsg('bot', h('p', { class: 'error' }, errText(e)));
  } finally {
    pending.remove();
    $('chat-send').disabled = false;
  }
}

// ---- Voice ------------------------------------------------------------------------------------
async function voiceStart() {
  show($('voice-panel'));
  clear($('captions'));
  $('voice-state').textContent = 'Asking for microphone access…';
  $('voice-btn').disabled = true;
  try {
    state.voice = await startVoice({
      householdId: state.householdId,
      lat: state.loc?.lat,
      lng: state.loc?.lng,
      onState: (t) => {
        $('voice-state').textContent = t;
      },
      onCaption: (role, t) => {
        $('captions').append(h('p', {}, h('strong', {}, role === 'user' ? 'You: ' : 'Assistant: '), t));
        $('captions').scrollTop = 1e6;
      },
      onEmergency: (m) => {
        $('voice-state').textContent = m.message;
        addMsg('bot emergency', h('h4', {}, 'This may be urgent'), h('p', {}, m.message));
      },
      onClosed: (r) => {
        $('voice-state').textContent = `Voice ended (${r.replaceAll('_', ' ')}).`;
        $('voice-btn').disabled = false;
        state.voice = null;
      },
    });
  } catch (e) {
    $('voice-state').textContent =
      e?.name === 'NotAllowedError'
        ? 'Microphone access was blocked. You can still type your question.'
        : 'Voice could not start. You can still type your question.';
    $('voice-btn').disabled = false;
  }
}

// ---- Community --------------------------------------------------------------------------------
function renderChallenge(c) {
  state.challengeId = c.id;
  show($('chal'));
  $('chal-title-out').textContent = c.title;
  $('chal-count').textContent = c.participantCountLabel;
  $('chal-link').textContent = `Share this challenge id: ${c.id}`;
  const ul = $('chal-actions');
  clear(ul);
  if (c.actionCounts)
    Object.entries(c.actionCounts).forEach(([k, n]) =>
      ul.append(h('li', {}, `${k.replaceAll('_', ' ')}: ${n} people`)),
    );
  else ul.append(h('li', {}, 'Action totals appear once at least 5 people take part.'));
}
async function newChallenge(ev) {
  ev.preventDefault();
  const start = new Date(),
    end = new Date(Date.now() + 7 * 86400000);
  try {
    renderChallenge(
      await api('POST', '/api/v1/community/challenges', {
        title: $('chal-title').value.trim(),
        description: '',
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
      }),
    );
  } catch (e) {
    $('chal-count').textContent = errText(e);
    show($('chal'));
  }
}
async function logAction() {
  try {
    renderChallenge(
      await api('POST', `/api/v1/community/challenges/${state.challengeId}/actions`, {
        actionKey: $('chal-action').value,
      }),
    );
  } catch (e) {
    $('chal-count').textContent = errText(e);
  }
}

// ---- Wire up ----------------------------------------------------------------------------------
$('loc-form').addEventListener('submit', (e) => {
  e.preventDefault();
  void checkAir();
});
$('geo').addEventListener('click', () => {
  if (!navigator.geolocation) {
    $('loc-error').textContent = 'Your browser cannot share location. Enter coordinates instead.';
    show($('loc-error'));
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (p) => {
      $('lat').value = p.coords.latitude.toFixed(2);
      $('lng').value = p.coords.longitude.toFixed(2);
      void checkAir();
    },
    () => {
      $('loc-error').textContent = 'Location was not shared. Enter coordinates instead.';
      show($('loc-error'));
    },
    { maximumAge: 600000, timeout: 10000 },
  );
});
$('house-form').addEventListener('submit', saveHousehold);
$('plan-btn').addEventListener('click', () => void buildPlan());
$('compare-btn').addEventListener('click', () => void compare());
$('img').addEventListener('change', syncButtons);
$('visual-form').addEventListener('submit', submitVisual);
$('chat-form').addEventListener('submit', ask);
$('voice-btn').addEventListener('click', () => void voiceStart());
$('voice-stop').addEventListener('click', () => state.voice?.stop());
$('chal-form').addEventListener('submit', newChallenge);
$('chal-log').addEventListener('click', () => void logAction());

(async () => {
  await loadConfig();
  const id = store.get('ca_household');
  if (id) {
    try {
      await api('GET', `/api/v1/households/${id}`);
      state.householdId = id;
      void refreshIndoor();
    } catch {
      store.set('ca_household', null);
    }
  }
  syncButtons();
})();
