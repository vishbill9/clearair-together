import { csrfToken } from './api.js';

const b64 = (buf) => {
  let s = '';
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Browser side of the live voice session. Audio goes only to our server over WSS; nothing is recorded locally. */
export async function startVoice({ householdId, lat, lng, onState, onCaption, onEmergency, onClosed }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule('/js/pcm-worklet.js');
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-capture');
  src.connect(node);

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const qs = new URLSearchParams({ csrf: csrfToken() });
  if (householdId) qs.set('householdId', householdId);
  else if (lat !== undefined) {
    qs.set('lat', lat);
    qs.set('lng', lng);
  }
  const ws = new WebSocket(`${proto}//${location.host}/api/v1/live/voice?${qs}`);

  let playAt = 0;
  const playing = new Set();
  const stopPlayback = () => {
    for (const s of playing) {
      try {
        s.stop();
      } catch {
        /* ended */
      }
    }
    playing.clear();
    playAt = 0;
  };
  let ready = false;

  node.port.onmessage = (e) => {
    if (ready && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: 'audio', data: b64(e.data) }));
  };

  const cleanup = () => {
    try {
      node.disconnect();
      src.disconnect();
    } catch {
      /* */
    }
    stream.getTracks().forEach((t) => t.stop());
    stopPlayback();
    void ctx.close();
  };

  ws.onopen = () => onState('Connecting…');
  ws.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.type === 'ready') {
      ready = true;
      onState(
        m.airQualityStatus === 'fresh' || m.airQualityStatus === 'cached'
          ? 'Listening. Speak when ready.'
          : 'Listening. Live air-quality data is not available, so answers are general guidance.',
      );
    } else if (m.type === 'caption') onCaption(m.role, m.text);
    else if (m.type === 'audio') {
      const pcm = Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0));
      const f = new Float32Array(pcm.length / 2);
      const dv = new DataView(pcm.buffer);
      for (let i = 0; i < f.length; i++) f[i] = dv.getInt16(i * 2, true) / 0x8000;
      const buf = ctx.createBuffer(1, f.length, 24000);
      buf.copyToChannel(f, 0);
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.connect(ctx.destination);
      playAt = Math.max(playAt, ctx.currentTime);
      s.start(playAt);
      playAt += buf.duration;
      playing.add(s);
      s.onended = () => playing.delete(s);
    } else if (m.type === 'interrupted')
      stopPlayback(); // barge-in
    else if (m.type === 'emergency') onEmergency(m);
    else if (m.type === 'blocked') onState(m.message);
    else if (m.type === 'error') onState(m.message);
    else if (m.type === 'closed') onClosed(m.reason);
  };
  ws.onerror = () => onState('Voice is unavailable right now.');
  ws.onclose = () => {
    cleanup();
    onClosed('closed');
  };

  return {
    stop: () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' }));
      setTimeout(() => ws.close(), 200);
    },
  };
}
