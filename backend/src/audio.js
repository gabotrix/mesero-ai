/**
 * Streaming linear resampler for PCM16LE mono.
 *
 * Keeps the fractional phase and the trailing sample between calls so that
 * consecutive frames splice without clicks. Linear interpolation is plenty for
 * 16 kHz <-> 24 kHz speech and costs almost nothing.
 */
export class Resampler {
  /**
   * @param {number} inRate
   * @param {number} outRate
   */
  constructor(inRate, outRate) {
    this.ratio = inRate / outRate; // input samples consumed per output sample
    this.phase = 0;
    this.last = 0;
    this.primed = false;
  }

  /**
   * @param {Buffer} pcmIn PCM16LE mono
   * @returns {Buffer} PCM16LE mono at the output rate
   */
  process(pcmIn) {
    const nIn = pcmIn.length >> 1;
    if (nIn === 0) return Buffer.alloc(0);

    const input = new Int16Array(nIn);
    for (let i = 0; i < nIn; i++) input[i] = pcmIn.readInt16LE(i << 1);

    if (!this.primed) {
      this.last = input[0];
      this.primed = true;
    }

    // Worst-case output length, trimmed at the end.
    const out = new Int16Array(Math.ceil((nIn + 1) / this.ratio) + 2);
    let o = 0;
    let pos = this.phase;

    while (pos < nIn) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i === 0 ? this.last : input[i - 1];
      const b = input[i];
      let v = a + (b - a) * frac;
      if (v > 32767) v = 32767;
      else if (v < -32768) v = -32768;
      out[o++] = v | 0;
      pos += this.ratio;
    }

    this.phase = pos - nIn;
    this.last = input[nIn - 1];

    const result = Buffer.allocUnsafe(o << 1);
    for (let i = 0; i < o; i++) result.writeInt16LE(out[i], i << 1);
    return result;
  }
}

/**
 * Re-chunks a byte stream into fixed-size frames. The device protocol wants
 * exactly 20 ms per frame; the voice provider sends whatever it feels like.
 */
export class FrameSplitter {
  /** @param {number} frameBytes */
  constructor(frameBytes) {
    this.frameBytes = frameBytes;
    this.buf = Buffer.alloc(0);
  }

  /**
   * @param {Buffer} chunk
   * @returns {Buffer[]} complete frames
   */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames = [];
    while (this.buf.length >= this.frameBytes) {
      frames.push(this.buf.subarray(0, this.frameBytes));
      this.buf = this.buf.subarray(this.frameBytes);
    }
    return frames;
  }

  reset() {
    this.buf = Buffer.alloc(0);
  }
}

/** Root-mean-square of a PCM16LE buffer, for cheap level metering. */
export function rms(pcm) {
  const n = pcm.length >> 1;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i << 1);
    sum += s * s;
  }
  return Math.sqrt(sum / n) | 0;
}
