import { $, $$, clear, h, show } from './dom.js';
import { api } from './api.js';
import { effectBadge, effectLabel, EFFORT_TEXT, errText, setMsg, state, syncButtons } from './state.js';

const FEEDBACK = [
  ['helpful', 'Helpful'],
  ['not_helpful', 'Not helpful'],
  ['done', 'Done'],
  ['not_feasible', 'Can’t do this'],
];

function feedbackButtons(id, note) {
  const send = async (eventType) => {
    try {
      await api('POST', `/api/v1/recommendations/${id}/feedback`, { eventType });
      note.textContent = 'Saved.';
    } catch (e) {
      note.textContent = errText(e);
    }
  };
  return FEEDBACK.map(([t, text]) =>
    h('button', { type: 'button', class: 'secondary', onclick: () => void send(t) }, text),
  );
}

function planItem(i) {
  const note = h('span', { class: 'hint', role: 'status' });
  return h(
    'li',
    {},
    h('h4', {}, i.title),
    h('p', {}, i.body),
    h(
      'div',
      { class: 'meta' },
      h('span', {}, EFFORT_TEXT[i.effort]),
      h('span', {}, i.basis === 'general_guidance' ? 'General guidance' : 'Based on verified data'),
      effectLabel('Exposure', i.exposureEffect),
      effectLabel('Emissions', i.emissionsEffect),
    ),
    h('div', { class: 'fb' }, i.id ? feedbackButtons(i.id, note) : []),
    note,
  );
}

function renderList(el, items, empty) {
  clear(el);
  for (const i of items) el.append(planItem(i));
  if (!items.length && empty) el.append(h('li', {}, empty));
}

async function buildPlan() {
  $('plan-btn').disabled = true;
  try {
    const p = await api('POST', `/api/v1/households/${state.householdId}/daily-plan`, {});
    show($('plan'));
    $('plan-headline').textContent = p.headline;
    setMsg($('plan-reason'), p.statusReason);
    renderList(
      $('plan-items'),
      p.items,
      'No day-specific actions are shown because there is no verified air-quality reading.',
    );
    renderList($('quick-wins'), p.indoorQuickWins);
    $('plan-note').textContent = p.generalGuidanceNote;
  } catch (e) {
    show($('plan'));
    $('plan-headline').textContent = errText(e);
  } finally {
    syncButtons();
  }
}

const routineRow = (o) =>
  h(
    'tr',
    {},
    h('th', { scope: 'row' }, o.label),
    h('td', { 'data-label': 'Your exposure' }, effectBadge(o.exposure)),
    h('td', { 'data-label': 'Emissions' }, effectBadge(o.emissions)),
    h('td', { 'data-label': 'Note' }, o.notes.join(' ')),
  );

async function compare() {
  const picks = $$('#cand input:checked').map((i) => /** @type {HTMLInputElement} */ (i).value);
  const msg = $('compare-msg');
  const tbl = $('compare-tbl');
  if (!picks.length) return setMsg(msg, 'Choose at least one option.');
  try {
    const d = await api('POST', '/api/v1/scenarios/compare', {
      householdId: state.householdId,
      candidates: picks,
    });
    const tb = tbl.tBodies[0];
    clear(tb);
    for (const o of d.options) tb.append(routineRow(o));
    show(tbl, d.options.length > 0);
    show($('compare-setup'), d.currentRoutine === 'unknown');
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

export function initPlan() {
  $('plan-btn').addEventListener('click', () => void buildPlan());
  $('compare-btn').addEventListener('click', () => void compare());
}
