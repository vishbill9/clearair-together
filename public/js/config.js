import { $, clear, h, show } from './dom.js';
import { api } from './api.js';
import { errText, state } from './state.js';

function missingFeatures(i) {
  const missing = [];
  if (!i.googleAirQuality)
    missing.push('Air-quality data is not configured on this server, so no readings are shown.');
  if (!i.assistant) missing.push('The assistant is not configured. Urgent-symptom guidance still works.');
  if (!i.database) missing.push('The database is not configured, so households and plans cannot be saved.');
  return missing;
}

function showBanner(missing) {
  if (!missing.length) return;
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

/** Voice needs the server feature and a browser that can use the microphone. */
function setVoiceAvailability(live) {
  const voiceOk = Boolean(live && navigator.mediaDevices?.getUserMedia);
  for (const id of ['voice-btn', 'talk-btn', 'voice-on']) show($(id), voiceOk);
  show($('voice-off'), !voiceOk);
  $('voice-off').textContent = live
    ? 'Your browser cannot use the microphone here. Use a recent browser over https, or type your question instead.'
    : 'Voice talk is not switched on for this server yet. You can still type your questions.';
}

/** Loads public feature flags and adapts the page to what this server supports. */
export async function loadConfig() {
  try {
    state.config = await api('GET', '/api/v1/config');
  } catch (e) {
    $('config-banner').textContent = errText(e);
    show($('config-banner'));
    return;
  }
  const i = state.config.integrations;
  showBanner(missingFeatures(i));
  setVoiceAvailability(i.live);
  $('explain-btn').disabled = !i.assistant;
  if (!i.assistant) $('chat-send').disabled = false; // still lets emergency wording through
}
