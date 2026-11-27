import { $, $$, h } from './dom.js';
import { api } from './api.js';
import { go } from './nav.js';
import { effectLabel, EFFORT_TEXT, errText, state, STATUS_TEXT } from './state.js';

const SOURCE_TITLES = {
  'epa-aqi-basics': 'US EPA AirNow: AQI basics',
  'who-air-pollution': 'WHO: Air pollution',
  'g-timing': 'General guidance: timing outdoor activity',
  'g-filtration': 'General guidance: indoor air cleaning',
  'g-source-control': 'General guidance: reducing indoor sources',
  'g-masks': 'General guidance: respirators',
  'g-commute': 'General guidance: commuting choices',
};
const BLOCKED_NOTE =
  'The generated answer did not pass safety checks, so this general reply is shown instead.';
const EXPLAIN_PROMPT =
  'Explain this air-quality reading in simple words and tell me what I should do about it today.';

/** Appends a chat bubble and keeps the newest message in view. */
export function addMsg(kind, ...nodes) {
  const m = h('div', { class: `msg ${kind}` }, nodes);
  const c = $('chat');
  c.append(m);
  c.scrollTop = c.scrollHeight;
  return m;
}

export const emergencyMsg = (message) =>
  addMsg('bot emergency', h('h4', {}, 'This may be urgent'), h('p', {}, message));

const section = (title, ...body) => [h('h4', {}, title), ...body];
const list = (items, render) =>
  h(
    'ul',
    {},
    items.map((x) => h('li', {}, render(x))),
  );

function actionsSection(o) {
  if (!o.recommendedActions.length) return [];
  return section(
    'What you can do',
    list(o.recommendedActions, (a) => [
      h('strong', {}, `${a.title}. `),
      a.detail,
      ` (${EFFORT_TEXT[a.effort]})`,
    ]),
  );
}

function footer(d, o) {
  const sources = o.sources.map((s) => SOURCE_TITLES[s.id] ?? s.id).join('; ');
  return [
    o.safetyNotice ? h('p', { class: 'notice' }, o.safetyNotice) : null,
    h('p', { class: 'hint' }, `Uncertainty: ${o.uncertainty}`),
    o.sources.length ? h('p', { class: 'hint' }, 'Sources (general guidance): ', sources) : null,
    h(
      'p',
      { class: 'hint' },
      `Air-quality data status: ${STATUS_TEXT[d.airQualityStatus] ?? d.airQualityStatus}`,
    ),
  ];
}

/** Renders a validated answer section by section; every field was checked by the server. */
function renderAnswer(d) {
  if (d.kind === 'emergency') return emergencyMsg(d.response.message);
  const o = d.output;
  addMsg('bot', [
    d.blocked ? h('p', { class: 'notice' }, BLOCKED_NOTE) : null,
    h('p', {}, o.directAnswer),
    ...actionsSection(o),
    ...(o.rationale ? section('Why', h('p', {}, o.rationale)) : []),
    ...(o.feasibleAlternative ? section('If that is hard', h('p', {}, o.feasibleAlternative)) : []),
    h(
      'p',
      { class: 'meta' },
      effectLabel('Exposure', o.exposureOpportunity),
      effectLabel('Emissions', o.emissionsOpportunity),
    ),
    ...(o.assumptions.length
      ? section(
          'Assumptions',
          list(o.assumptions, (x) => x),
        )
      : []),
    ...footer(d, o),
  ]);
}

/** The household gives the best context; otherwise the checked location is sent. */
function questionBody(message) {
  if (state.householdId) return { message, householdId: state.householdId };
  return state.loc ? { message, lat: state.loc.lat, lng: state.loc.lng } : { message };
}

async function ask(ev) {
  ev.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text) return;
  addMsg('user', h('p', {}, text));
  $('chat-input').value = '';
  $('chat-send').disabled = true;
  const pending = addMsg('bot', h('p', { class: 'hint' }, 'Thinking…'));
  try {
    renderAnswer(await api('POST', '/api/v1/assistant/messages', questionBody(text)));
  } catch (e) {
    addMsg('bot', h('p', { class: 'error' }, errText(e)));
  } finally {
    pending.remove();
    $('chat-send').disabled = false;
  }
}

function askText(text) {
  go('ask');
  $('chat-input').value = text;
  $('chat-form').requestSubmit();
}

export function initAssistant() {
  $('chat-form').addEventListener('submit', ask);
  for (const c of $$('.chip[data-q]')) c.addEventListener('click', () => askText(c.dataset.q));
  $('explain-btn').addEventListener('click', () => askText(EXPLAIN_PROMPT));
}
