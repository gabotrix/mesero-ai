/**
 * Kitchen ticket lifecycle, end to end against a running backend.
 *
 * Drives the pack's own tools over HTTP instead of speaking, so the result is
 * deterministic and costs no model time; everything after the tool call — the
 * order reducer, the ticket bookkeeping and the screen fan-out — is the exact
 * path a spoken order takes.
 *
 *   node test/tickets.mjs
 */
const BASE = 'http://localhost:8787';
const DOCK = 'mesa-tickets';

const fails = [];
const check = (label, ok) => {
  if (!ok) fails.push(label);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
};

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const tool = (name, args = {}, doa) => post(`/api/dock/${DOCK}/tool`, { name, args, doa });
const setStatus = (id, status) => post(`/api/dock/${DOCK}/ticket/${id}/status`, { status });
const state = async () =>
  (await fetch(`${BASE}/api/dock/${DOCK}`).then((r) => r.json()));

// Start from a known-empty table: a previous run must not decide this one.
await post(`/api/dock/${DOCK}/reset`);

console.log('\nseats and per-diner attribution');
// Two bearings 160 degrees apart are two people; the seat map must not merge them.
await tool('add_item', { sku: 'bandeja-paisa', qty: 2 }, 40);
await tool('add_item', { sku: 'jugo-lulo', qty: 1 }, 200);
let s = await state();
check('two diners detected from two bearings', s.people === 2);
check('order totals 72000', s.total === 72000);

console.log('\nconfirming freezes the round into a kitchen ticket');
await tool('confirm_order');
s = await state();
check('one ticket created', s.tickets.length === 1);
check('ticket starts in the kitchen', s.tickets[0]?.status === 'kitchen');
check('ticket is numbered 1', s.tickets[0]?.n === 1);

console.log('\nthe kitchen board advances it');
const id = s.tickets[0].id;
for (const next of ['preparing', 'ready', 'served']) {
  const res = await setStatus(id, next);
  s = await state();
  check(`-> ${next}`, res.status === 200 && s.tickets[0].status === next);
}

console.log('\nbad input is refused, not absorbed');
check('unknown status rejected', (await setStatus(id, 'quemado')).status === 422);
check('unknown ticket rejected', (await setStatus('t99', 'ready')).status === 422);

console.log('\na later round becomes its own ticket');
await tool('add_item', { sku: 'tres-leches', qty: 1 }, 200);
s = await state();
check('served ticket is untouched by a new item', s.tickets[0].status === 'served');
await tool('confirm_order');
s = await state();
check('second ticket created', s.tickets.length === 2);
check('second ticket numbered 2', s.tickets[1]?.n === 2);
check('second ticket starts in the kitchen', s.tickets[1]?.status === 'kitchen');

console.log('\nreset clears the table');
await post(`/api/dock/${DOCK}/reset`);
s = await state();
check('no tickets left', (s.tickets || []).length === 0);
check('no total left', s.total === 0);

console.log(fails.length ? `\nFAIL (${fails.length}): ${fails.join(', ')}\n` : '\nPASS\n');
process.exit(fails.length ? 1 : 0);
