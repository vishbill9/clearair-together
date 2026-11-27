import { $ } from './dom.js';
import { api } from './api.js';
import { errText, rememberHousehold, state, syncButtons } from './state.js';

/** Members are described by age group only; no names or ages are collected. */
function members() {
  const caution = $('m-caution').checked;
  const out = [];
  if ($('m-child').checked) out.push({ label: 'Child', ageGroup: 'child', needsExtraCaution: caution });
  if ($('m-older').checked)
    out.push({ label: 'Older adult', ageGroup: 'older_adult', needsExtraCaution: caution });
  if (!out.length && caution) out.push({ label: 'Adult', ageGroup: 'adult', needsExtraCaution: true });
  return out;
}

function constraints() {
  return {
    commuteMode: $('c-commute').value,
    cookingFuel: $('c-fuel').value,
    timeFlexibility: $('c-time').value,
    budgetLevel: $('c-budget').value,
    canWorkFromHome: $('c-wfh').checked,
    hasAirPurifier: $('c-purifier').checked,
    hasPets: $('c-pets').checked,
  };
}

async function saveHousehold(ev) {
  ev.preventDefault();
  const msg = $('house-msg');
  if (!state.loc) {
    msg.textContent = 'Set your location first.';
    return;
  }
  const body = {
    name: $('h-name').value.trim() || 'Home',
    lat: state.loc.lat,
    lng: state.loc.lng,
    members: members(),
    constraints: constraints(),
  };
  $('house-save').disabled = true;
  try {
    rememberHousehold((await api('POST', '/api/v1/households', body)).id);
    msg.textContent = 'Household saved.';
    syncButtons();
  } catch (e) {
    msg.textContent = errText(e);
  } finally {
    $('house-save').disabled = false;
  }
}

export function initHousehold() {
  $('house-form').addEventListener('submit', saveHousehold);
}
