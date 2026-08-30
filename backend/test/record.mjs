/**
 * Records what the gadget would actually hear, to agent-speech.wav.
 *
 * Catches the failure that a connectivity smoke test cannot: a resampler that
 * happily delivers the right number of bytes of noise.
 *
 *   node test/record.mjs [seconds]
 */
import { WebSocket } from 'ws';
import { writeFileSync } from 'node:fs';

const SECONDS = Number(process.argv[2] || 10);
const BASE = 'ws://localhost:8787';
const DOCK = 'mesa-rec';
const RATE = 16000;
const HEADER = 8;

const chunks = [];

const ui = new WebSocket(`${BASE}/ui?dock=${DOCK}`);
await new Promise((r) => ui.once('open', r));

const dev = new WebSocket(`${BASE}/device?dock=${DOCK}`);
dev.binaryType = 'nodebuffer';
let ready = false;

dev.on('open', () =>
  dev.send(
    JSON.stringify({
      t: 'hello', proto: 1, dock: DOCK,
      device: { id: 'rec', model: 'recorder', fw: '0.0.1' },
      audio: { rate: RATE, bits: 16, ch: 1, frameMs: 20 },
      caps: [],
    })
  )
);

dev.on('message', (data, isBinary) => {
  if (isBinary) {
    if (data.length > HEADER && data[0] === 0xa5 && data[2] === 0x02) {
      chunks.push(Buffer.from(data.subarray(HEADER)));
    }
    return;
  }
  const m = JSON.parse(data.toString());
  if (m.t === 'welcome') ready = true;
  if (m.t === 'ping') dev.send(JSON.stringify({ t: 'pong', ts: m.ts }));
});

const silence = Buffer.alloc(320 * 2);
const head = Buffer.from([0xa5, 1, 1, 0, 0, 0, 0xff, 0xff]);
const timer = setInterval(() => {
  if (ready && dev.readyState === 1) dev.send(Buffer.concat([head, silence]));
}, 20);

await new Promise((r) => setTimeout(r, SECONDS * 1000));
clearInterval(timer);
dev.close();
ui.close();

const pcm = Buffer.concat(chunks);
const n = pcm.length >> 1;

let peak = 0;
let sumSq = 0;
let zeroCross = 0;
let prev = 0;
for (let i = 0; i < n; i++) {
  const s = pcm.readInt16LE(i << 1);
  const a = Math.abs(s);
  if (a > peak) peak = a;
  sumSq += s * s;
  if ((s < 0) !== (prev < 0)) zeroCross++;
  prev = s;
}
const rms = Math.sqrt(sumSq / (n || 1));

// Minimal 16-bit mono WAV header.
const wav = Buffer.alloc(44 + pcm.length);
wav.write('RIFF', 0);
wav.writeUInt32LE(36 + pcm.length, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(RATE, 24);
wav.writeUInt32LE(RATE * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(pcm.length, 40);
pcm.copy(wav, 44);
writeFileSync('agent-speech.wav', wav);

const seconds = n / RATE;
console.log(
  JSON.stringify(
    {
      seconds: Number(seconds.toFixed(2)),
      samples: n,
      peak,
      rms: Math.round(rms),
      // Speech at 16 kHz lands roughly in the hundreds-to-low-thousands per second.
      // White noise from a broken resampler sits an order of magnitude higher.
      zeroCrossingsPerSec: Math.round(zeroCross / (seconds || 1)),
      file: 'agent-speech.wav',
    },
    null,
    2
  )
);
process.exit(0);
