import { $, clear, h, show } from './dom.js';
import { go } from './nav.js';
import { startVoice } from './voice.js';
import { emergencyMsg } from './assistant.js';
import { state } from './state.js';

const setVoiceState = (t) => {
  $('voice-state').textContent = t;
};

function setLive(on) {
  $('voice-btn').disabled = on;
  $('voice-card').classList.toggle('voice-live', on);
}

function addCaption(role, text) {
  $('captions').append(h('p', {}, h('strong', {}, role === 'user' ? 'You: ' : 'Assistant: '), text));
  $('captions').scrollTop = 1e6;
}

function onClosed(reason) {
  setVoiceState(`Voice ended (${reason.replaceAll('_', ' ')}).`);
  setLive(false);
  state.voice = null;
}

async function voiceStart() {
  show($('voice-panel'));
  clear($('captions'));
  setLive(true);
  setVoiceState('Asking for microphone access…');
  try {
    state.voice = await startVoice({
      householdId: state.householdId,
      lat: state.loc?.lat,
      lng: state.loc?.lng,
      onState: setVoiceState,
      onCaption: addCaption,
      onEmergency: (m) => {
        setVoiceState(m.message);
        emergencyMsg(m.message);
      },
      onClosed,
    });
  } catch (e) {
    setVoiceState(
      e?.name === 'NotAllowedError'
        ? 'Microphone access was blocked. You can still type your question.'
        : 'Voice could not start. You can still type your question.',
    );
    setLive(false);
  }
}

export function initVoicePanel() {
  $('voice-btn').addEventListener('click', () => void voiceStart());
  $('voice-stop').addEventListener('click', () => state.voice?.stop());
  $('talk-btn').addEventListener('click', () => {
    go('ask');
    if (!$('voice-btn').disabled) void voiceStart();
  });
}
