// Runs in the audio thread: converts mic float samples to 16-bit PCM chunks (~100 ms at 16 kHz after resampling).
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = [];
    this.ratio = sampleRate / 16000;
    this.acc = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += 1;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        this.buf.push(Math.max(-1, Math.min(1, ch[i])));
      }
    }
    if (this.buf.length >= 1600) {
      const out = new Int16Array(this.buf.length);
      for (let i = 0; i < out.length; i++)
        out[i] = this.buf[i] < 0 ? this.buf[i] * 0x8000 : this.buf[i] * 0x7fff;
      this.buf = [];
      this.port.postMessage(out.buffer, [out.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
