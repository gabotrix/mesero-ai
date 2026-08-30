/**
 * Wire protocol v1 — see docs/protocolo.md
 * Binary audio frames: 8-byte little-endian header + PCM16LE mono payload.
 */

export const MAGIC = 0xa5;
export const VERSION = 0x01;

export const FRAME_MIC = 0x01; // device -> backend
export const FRAME_SPK = 0x02; // backend -> device

export const FLAG_VAD = 0b0001;
export const FLAG_EOU = 0b0010;
export const FLAG_COMFORT = 0b0100;

export const HEADER_BYTES = 8;
export const DOA_UNKNOWN = 0xffff;

/** Device-side audio format. Fixed in v1. */
export const DEVICE_RATE = 16000;
export const DEVICE_FRAME_MS = 20;
export const DEVICE_FRAME_SAMPLES = (DEVICE_RATE * DEVICE_FRAME_MS) / 1000; // 320

/**
 * @param {{type:number, flags?:number, seq?:number, doa?:number, pcm:Buffer}} f
 * @returns {Buffer}
 */
export function encodeAudioFrame({ type, flags = 0, seq = 0, doa = DOA_UNKNOWN, pcm }) {
  const head = Buffer.allocUnsafe(HEADER_BYTES);
  head[0] = MAGIC;
  head[1] = VERSION;
  head[2] = type;
  head[3] = flags & 0xff;
  head.writeUInt16LE(seq & 0xffff, 4);
  head.writeUInt16LE(doa & 0xffff, 6);
  return Buffer.concat([head, pcm], HEADER_BYTES + pcm.length);
}

/**
 * @param {Buffer} buf
 * @returns {{type:number, flags:number, seq:number, doa:number, pcm:Buffer}|null}
 */
export function decodeAudioFrame(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_BYTES) return null;
  if (buf[0] !== MAGIC || buf[1] !== VERSION) return null;
  const doa = buf.readUInt16LE(6);
  return {
    type: buf[2],
    flags: buf[3],
    seq: buf.readUInt16LE(4),
    doa,
    pcm: buf.subarray(HEADER_BYTES),
  };
}
