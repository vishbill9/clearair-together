import { csrfToken } from './api.js';

const OUTPUT_SAMPLE_RATE = 24000;

const b64 = (buf) => {
  let s = '';
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

/** 16-bit little-endian PCM (base64) to floats in [-1, 1]. */
function pcmToFloats(data) {
  const pcm = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const dv = new DataView(pcm.buffer);
  const f = new Float32Array(pcm.length / 2);
  for (let i = 0; i < f.length; i++) f[i] = dv.getInt16(i * 2, true) / 0x8000;
  return f;
}

/** Plays audio chunks back to back; `stop` supports barge-in when the user interrupts. */
class Player {
  constructor(ctx) {
    this.ctx = ctx;
    this.playAt = 0;
    this.playing = new Set();
  }

  play(data) {
    const f = pcmToFloats(data);
    const buf = this.ctx.createBuffer(1, f.length, OUTPUT_SAMPLE_RATE);
    buf.copyToChannel(f, 0);
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.connect(this.ctx.destination);
    this.playAt = Math.max(this.playAt, this.ctx.currentTime);
    s.start(this.playAt);
    this.playAt += buf.duration;
    this.playing.add(s);
    s.onended = () => this.playing.delete(s);
  }

  stop() {
    for (const s of this.playing) {
      try {
        s.stop();
      } catch {
        /* already ended */
      }
    }
    this.playing.clear();
    this.playAt = 0;
  }
}

/** Microphone to 16 kHz PCM via an AudioWorklet. Nothing is recorded or stored in the browser. */
async function openMic(ctx) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  await ctx.audioWorklet.addModule('/js/pcm-worklet.js');
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-capture');
  src.connect(node);
  const close = () => {
    try {
      node.disconnect();
      src.disconnect();
    } catch {
      /* already disconnected */
    }
    stream.getTracks().forEach((t) => t.stop());
  };
  return { port: node.port, close };
}

function voiceUrl({ householdId, lat, lng }) {
  const qs = new URLSearchParams({ csrf: csrfToken() });
  if (householdId) qs.set('householdId', householdId);
  else if (lat !== undefined) {
    qs.set('lat', lat);
    qs.set('lng', lng);
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/v1/live/voice?${qs}`;
}

const readyText = (status) =>
  status === 'fresh' || status === 'cached'
    ? 'Listening. Speak when ready.'
    : 'Listening. Live air-quality data is not available, so answers are general guidance.';

/** Browser side of the live voice session. Audio goes only to our server over WSS. */
export async function startVoice(opts) {
  const { onState, onCaption, onEmergency, onClosed } = opts;
  const ctx = new AudioContext();
  const mic = await openMic(ctx);
  const player = new Player(ctx);
  const ws = new WebSocket(voiceUrl(opts));
  let ready = false;

  mic.port.onmessage = (e) => {
    if (ready && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: 'audio', data: b64(e.data) }));
  };

  const handlers = {
    ready: (m) => {
      ready = true;
      onState(readyText(m.airQualityStatus));
    },
    caption: (m) => onCaption(m.role, m.text),
    audio: (m) => player.play(m.data),
    interrupted: () => player.stop(),
    emergency: (m) => onEmergency(m),
    blocked: (m) => onState(m.message),
    error: (m) => onState(m.message),
    closed: (m) => onClosed(m.reason),
  };

  ws.onopen = () => onState('Connecting…');
  ws.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    handlers[m.type]?.(m);
  };
  ws.onerror = () => onState('Voice is unavailable right now.');
  ws.onclose = () => {
    mic.close();
    player.stop();
    void ctx.close();
    onClosed('closed');
  };

  return {
    stop: () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' }));
      setTimeout(() => ws.close(), 200);
    },
  };
}
