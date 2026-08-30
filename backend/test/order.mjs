/**
 * Orders food end to end and asserts the table screen ends up correct.
 *
 * Drives the agent with text instead of speech so the result is deterministic;
 * everything after the model — tool calls, order reducer, screen fan-out — is
 * the exact path a spoken order takes.
 *
 *   node test/order.mjs
 */
import { WebSocket } from 'ws';

const BASE = 'ws://localhost:8787';
const HTTP = 'http://localhost:8787';
const DOCK = 'mesa-order';
const SAY = 'Buenas, quiero dos bandejas paisas y un jugo de lulo, por favor.';

// A table outlives the run that used it, and that breaks a second run two ways:
// the order is still there, so the totals come out double; and the agent is
// still connected, so it never greets again — this test waits for that greeting
// before injecting its line, and without it the line lands in a conversation
// that already took this order. Sleeping the table drops the model connection,
// so attaching the screen below starts a genuinely fresh agent.
await fetch(`${HTTP}/hooks/dock/${DOCK}/sleep`, { method: 'POST' }).catch(() => {});
await fetch(`${HTTP}/api/dock/${DOCK}/reset`, { method: 'POST' }).catch(() => {});

const tools = [];
let finalState = null;
let ready = false;
let spoke = false;

const ui = new WebSocket(`${BASE}/ui?dock=${DOCK}`);
ui.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.t === 'snapshot') finalState = m.state;
  if (m.t === 'state') finalState = m.state;
  if (m.t === 'tool') tools.push({ name: m.name, args: m.args });
  // The agent greets on connect. Injecting a customer turn while that response
  // is still running is rejected outright, so wait for it to finish.
  if (m.t === 'agent_state') {
    if (m.state === 'talking') spoke = true;
    if (spoke && m.state === 'listening') ready = true;
  }
});
await new Promise((r) => ui.once('open', r));

const dev = new WebSocket(`${BASE}/device?dock=${DOCK}`);
dev.binaryType = 'nodebuffer';
dev.on('open', () =>
  dev.send(
    JSON.stringify({
      t: 'hello', proto: 1, dock: DOCK,
      device: { id: 'order-test', model: 'order-test', fw: '0.0.1' },
      audio: { rate: 16000, bits: 16, ch: 1, frameMs: 20 },
      caps: [],
    })
  )
);
dev.on('message', (data, isBinary) => {
  if (isBinary) return;
  const m = JSON.parse(data.toString());
  if (m.t === 'ping') dev.send(JSON.stringify({ t: 'pong', ts: m.ts }));
});

// Wait for the greeting to be fully spoken before injecting a customer turn.
for (let i = 0; i < 200 && !ready; i++) await new Promise((r) => setTimeout(r, 200));
await new Promise((r) => setTimeout(r, 1200));

ui.send(JSON.stringify({ t: 'ui_action', action: 'say', text: SAY }));

await new Promise((r) => setTimeout(r, 16000));

const items = finalState?.items || [];
const byS = Object.fromEntries(items.map((i) => [i.sku, i.qty]));
const expected = { 'bandeja-paisa': 2, 'jugo-lulo': 1 };
const ok =
  byS['bandeja-paisa'] === expected['bandeja-paisa'] &&
  byS['jugo-lulo'] === expected['jugo-lulo'] &&
  finalState?.total === 32000 * 2 + 8000;

console.log(
  JSON.stringify(
    {
      said: SAY,
      toolsCalled: tools.map((t) => `${t.name}(${JSON.stringify(t.args)})`),
      screen: finalState?.screen,
      title: finalState?.title,
      items: items.map((i) => `${i.qty}x ${i.label} = ${i.price * i.qty}`),
      total: finalState?.total,
      expectedTotal: 72000,
      PASS: ok,
    },
    null,
    2
  )
);

dev.close();
ui.close();
process.exit(ok ? 0 : 1);
