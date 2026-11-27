import { $, show } from './dom.js';
import { api } from './api.js';
import { initAssistant } from './assistant.js';
import { initCommunity } from './community.js';
import { loadConfig } from './config.js';
import { initHousehold } from './household.js';
import { initNav } from './nav.js';
import { initPlan } from './plan.js';
import { initPlants } from './plants.js';
import { checkAir, initStatus } from './status.js';
import { rememberHousehold, state, store, syncButtons } from './state.js';
import { initVoicePanel } from './voice-panel.js';

function resetHome() {
  state.aq = null;
  rememberHousehold(null);
  document.body.dataset.sky = 'none';
  syncButtons();
}

/** Loads a signed-in user's latest household and shows its reading. */
function restoreHousehold(hh) {
  rememberHousehold(hh.id);
  $('lat').value = Number(hh.lat).toFixed(2);
  $('lng').value = Number(hh.lng).toFixed(2);
  state.loc = { lat: hh.lat, lng: hh.lng };
  void checkAir();
}

/** Called on load, sign-in, sign-up and sign-out so the screen always matches who is signed in. */
async function onAccount(me, reason, before) {
  if (reason === 'logout') {
    resetHome();
    show($('hero-actions'), false);
    return;
  }
  if (me.kind !== 'registered') return;
  // Signing in to a different account replaces whatever was on screen; registering keeps it.
  if (reason === 'login' && before?.kind !== 'registered') resetHome();
  if (me.household && (reason === 'login' || !state.householdId)) restoreHousehold(me.household);
  syncButtons();
}

/** A household saved in this browser is reused only if the server still says it is ours. */
async function restoreSavedHousehold() {
  const id = store.get('ca_household');
  if (!id) return;
  try {
    await api('GET', `/api/v1/households/${id}`);
    state.householdId = id;
  } catch {
    store.set('ca_household', null);
  }
}

initStatus();
initHousehold();
initPlan();
initAssistant();
initVoicePanel();
initCommunity();

(async () => {
  await loadConfig();
  void initPlants({ chatOn: Boolean(state.config?.integrations.plantChat) });
  await initNav({ onAccount, googleLogin: state.config?.integrations.googleLogin });
  await restoreSavedHousehold();
  syncButtons();
})();
