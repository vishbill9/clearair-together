import { $, h, show } from './dom.js';
import { ApiError } from './api.js';

/** Shared client state. Only ids and the last reading are kept; nothing sensitive is stored. */
export const state = { loc: null, aq: null, householdId: null, config: null, challengeId: null, voice: null };

/** localStorage wrapper that tolerates private mode and blocked storage. */
export const store = {
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

export const STATUS_TEXT = {
  fresh: 'Live',
  cached: 'Recent (cached)',
  stale: 'Stale: provider unreachable',
  unavailable: 'Unavailable',
  not_configured: 'Not configured',
};
export const EFFECT_TEXT = {
  lower: 'Lower',
  similar: 'About the same',
  higher: 'Higher',
  unknown: 'Unknown',
};
export const EFFORT_TEXT = { low: 'Low effort', medium: 'Medium effort', high: 'High effort' };

export const fmt = (iso) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const errText = (e) => (e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');

/** Shows `text` in a notice element, or hides it when empty. */
export function setMsg(el, text, isNotice = true) {
  el.textContent = text || '';
  show(el, Boolean(text));
  if (isNotice) el.classList.add('notice');
}

/** Coloured "Lower / About the same / Higher" badge for an exposure or emissions effect. */
export const effectBadge = (effect) =>
  h('span', { class: 'eff', dataset: { e: effect } }, EFFECT_TEXT[effect]);

/** "Exposure: Lower" style label used in plans and answers. */
export const effectLabel = (name, effect) => h('span', {}, `${name}: `, effectBadge(effect));

/** Plan and routine buttons need a saved household. */
export function syncButtons() {
  const ready = Boolean(state.householdId);
  $('plan-btn').disabled = !ready;
  $('compare-btn').disabled = !ready;
  $('plan-hint').textContent = ready
    ? 'Plans use your household and the latest verified air-quality data.'
    : 'Save your household first.';
}

export function rememberHousehold(id) {
  state.householdId = id;
  store.set('ca_household', id);
}
