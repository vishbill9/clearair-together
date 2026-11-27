import { $, clear, h, show } from './dom.js';
import { api } from './api.js';
import { errText, state } from './state.js';

const WEEK_MS = 7 * 86_400_000;

/** Only group totals are shown, and only once at least 5 people take part. */
function renderChallenge(c) {
  state.challengeId = c.id;
  show($('chal'));
  $('chal-title-out').textContent = c.title;
  $('chal-count').textContent = c.participantCountLabel;
  $('chal-link').textContent = `Share this challenge id: ${c.id}`;
  const ul = $('chal-actions');
  clear(ul);
  if (!c.actionCounts)
    return ul.append(h('li', {}, 'Action totals appear once at least 5 people take part.'));
  for (const [k, n] of Object.entries(c.actionCounts))
    ul.append(h('li', {}, `${k.replaceAll('_', ' ')}: ${n} people`));
}

async function newChallenge(ev) {
  ev.preventDefault();
  const now = Date.now();
  try {
    renderChallenge(
      await api('POST', '/api/v1/community/challenges', {
        title: $('chal-title').value.trim(),
        description: '',
        startsAt: new Date(now).toISOString(),
        endsAt: new Date(now + WEEK_MS).toISOString(),
      }),
    );
  } catch (e) {
    $('chal-count').textContent = errText(e);
    show($('chal'));
  }
}

async function logAction() {
  try {
    const body = { actionKey: $('chal-action').value };
    renderChallenge(await api('POST', `/api/v1/community/challenges/${state.challengeId}/actions`, body));
  } catch (e) {
    $('chal-count').textContent = errText(e);
  }
}

export function initCommunity() {
  $('chal-form').addEventListener('submit', newChallenge);
  $('chal-log').addEventListener('click', () => void logAction());
}
