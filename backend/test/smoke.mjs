// End-to-end smoke test: fake gadget + fake screen against the running backend.
import { WebSocket } from 'ws';

const BASE = 'ws://localhost:8787';
const HTTP_BASE = 'http://localhost:8787';

/*
 * This suite drives the agent, so it needs a model to answer.
 *
 * Everything else in this backend runs uncredentialed on purpose, and a clone
 * that fails its own tests out of the box reads as broken software rather than
 * as unconfigured software. So: check, say so plainly, and exit clean.
 */
const health = await fetch(`${HTTP_BASE}/api/health`)
  .then((r) => r.json())
  .catch(() => null);

if (!health) {
  console.log('OMITIDA — no hay backend escuchando. Arráncalo con: node src/index.js');
  process.exit(0);
}
if (!health.voice?.ready) {
  console.log(
    `OMITIDA — esta prueba necesita una voz que responda.
` +
      `  proveedor: ${health.voice?.provider}
` +
      `  falta:     ${health.voice?.needs}
` +
      `Todo lo demás del repo funciona sin eso; solo estas pruebas hablan con el modelo.`,
  );
  process.exit(0);
}

const DOCK = 'mesa-e2e';
const HEADER = 8;
const FRAME_SAMPLES = 320;

function encodeFrame(type, pcm, seq = 0, flags = 0, doa = 0xffff) {
  const h = Buffer.allocUnsafe(HEADER);
  h[0] = 0xa5; h[1] = 1; h[2] = type; h[3] = flags;
  h.writeUInt16LE(seq & 0xffff, 4);
  h.writeUInt16LE(doa, 6);
  return Buffer.concat([h, pcm]);
}
function decodeFrame(b) {
  if (b.length < HEADER || b[0] !== 0xa5) return null;
  return { type: b[2], pcm: b.subarray(HEADER) };
}

const report = { uiMsgs: [], deviceJson: [], spkFrames: 0, spkBytes: 0, errors: [] };

// ---- screen first: this is the NFC tap that wakes the table
const ui = new WebSocket(`${BASE}/ui?dock=${DOCK}`);
ui.on('message', (d) => {
  const m = JSON.parse(d.toString());
  report.uiMsgs.push(m.t + (m.state ? `:${m.state}` : '') + (m.awake !== undefined ? `:${m.awake}` : ''));
});
ui.on('error', (e) => report.errors.push('ui ' + e.message));

await new Promise((r) => ui.once('open', r));

// ---- gadget
const dev = new WebSocket(`${BASE}/device?dock=${DOCK}&venue=${process.env.VENUE_KEY ?? ''}`);
dev.binaryType = 'nodebuffer';
let ready = false;
let seq = 0;

dev.on('open', () => {
  dev.send(JSON.stringify({
    t: 'hello', proto: 1, dock: DOCK,
    device: { id: 'e2e', model: 'e2e-test', fw: '0.0.1' },
    audio: { rate: 16000, bits: 16, ch: 1, frameMs: 20 },
    caps: ['vad'],
  }));
});

dev.on('message', (data, isBinary) => {
  if (isBinary) {
    const f = decodeFrame(data);
    if (f?.type === 0x02) { report.spkFrames++; report.spkBytes += f.pcm.length; }
    return;
  }
  const m = JSON.parse(data.toString());
  report.deviceJson.push(m.t + (m.state ? `:${m.state}` : ''));
  if (m.t === 'welcome') ready = true;
  if (m.t === 'ping') dev.send(JSON.stringify({ t: 'pong', ts: m.ts }));
});
dev.on('error', (e) => report.errors.push('dev ' + e.message));

// ---- stream 20 ms of silence, like a quiet table
const silence = Buffer.alloc(FRAME_SAMPLES * 2);
const timer = setInterval(() => {
  if (ready && dev.readyState === 1) {
    seq = (seq + 1) & 0xffff;
    dev.send(encodeFrame(0x01, silence, seq));
  }
}, 20);

await new Promise((r) => setTimeout(r, 14000));
clearInterval(timer);

const secs = report.spkBytes / 2 / 16000;
console.log(JSON.stringify({
  uiMsgs: [...new Set(report.uiMsgs)],
  uiCount: report.uiMsgs.length,
  deviceJson: [...new Set(report.deviceJson)],
  spkFrames: report.spkFrames,
  spkSeconds: Number(secs.toFixed(2)),
  errors: report.errors,
}, null, 2));

dev.close(); ui.close();
process.exit(0);
