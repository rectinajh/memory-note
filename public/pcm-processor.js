class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const inputRate = options.processorOptions?.inputSampleRate || sampleRate;
    const targetRate = options.processorOptions?.targetSampleRate || 16000;
    this.step = inputRate / targetRate;
    this.acc = [];
    this.pos = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || !input.length) return true;
    for (let i = 0; i < input.length; i++) this.acc.push(input[i]);

    const out = [];
    while (this.pos + 1 < this.acc.length) {
      const idx = Math.floor(this.pos);
      const frac = this.pos - idx;
      const a = this.acc[idx] ?? 0;
      const b = this.acc[Math.min(idx + 1, this.acc.length - 1)] ?? a;
      const sample = a + (b - a) * frac;
      out.push(Math.max(-1, Math.min(1, sample)));
      this.pos += this.step;
    }

    const drop = Math.max(0, Math.floor(this.pos) - 1);
    if (drop > 0) {
      this.acc.splice(0, drop);
      this.pos -= drop;
    }
    if (this.acc.length > 48000) {
      const extra = this.acc.length - 8000;
      this.acc.splice(0, extra);
      this.pos = Math.max(0, this.pos - extra);
    }
    if (!out.length) return true;

    const pcm16 = new Int16Array(out.length);
    for (let i = 0; i < out.length; i++) {
      const sample = out[i];
      pcm16[i] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
    }
    this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
