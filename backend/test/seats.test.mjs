/**
 * Does the bearing logic tell the people at a table apart?
 *
 * There is no hardware in CI, so the array is simulated: each diner sits at a
 * fixed azimuth and every frame arrives with noise around it, plus the
 * occasional wild sample standing in for a reflection off a wall or a lock
 * onto the speaker.
 *
 * The numbers below (±8° jitter, one outlier in twelve) come from watching
 * `[mic] doa=` on a real table. They are not a specification of the hardware —
 * they are a floor: the logic has to survive at least this much mess.
 *
 * Deterministic on purpose. A seeded generator means a failure here is a
 * failure anyone can reproduce, rather than a thing that happens on Tuesdays.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { SeatMap, angleDistance } from '../src/seats.js';

/** Small xorshift, so the same run produces the same table every time. */
function rng(seed = 42) {
  let x = seed;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 100000) / 100000;
  };
}

const wrap = (d) => ((Math.round(d) % 360) + 360) % 360;

/** One person speaking: `n` frames around `at`, with jitter and outliers. */
function utterance(rand, at, n = 20, { jitter = 8, outlierRate = 1 / 12 } = {}) {
  return Array.from({ length: n }, () =>
    rand() < outlierRate
      ? wrap(rand() * 360) // a reflection: could come from anywhere
      : wrap(at + (rand() * 2 - 1) * jitter),
  );
}

// The estimator lives in session.js, which opens sockets on import. It is
// twenty lines and reproducing it here would let the two drift apart, so the
// file is read and the function pulled out of it. Ugly, and better than
// testing a copy of the thing instead of the thing.
const { bearingOf } = await (async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/session.js', import.meta.url), 'utf8');
  const start = src.indexOf('function bearingOf(');
  assert.ok(start > 0, 'bearingOf no encontrada en session.js');
  const end = src.indexOf('\n}', start) + 2;
  const mod = `${src.slice(start, end)}\nexport { bearingOf };`;
  return import(
    `data:text/javascript,${encodeURIComponent(
      `import { angleDistance } from ${JSON.stringify(new URL('../src/seats.js', import.meta.url).href)};\n${mod}`,
    )}`
  );
})();

test('a median survives reflections that drag a mean off the speaker', () => {
  const rand = rng(7);
  const truth = 120;
  const samples = utterance(rand, truth, 24);

  const mean = (() => {
    let x = 0;
    let y = 0;
    for (const d of samples) {
      x += Math.cos((d * Math.PI) / 180);
      y += Math.sin((d * Math.PI) / 180);
    }
    return wrap((Math.atan2(y, x) * 180) / Math.PI);
  })();

  const { angle } = bearingOf(samples);
  const medianErr = angleDistance(angle, truth);
  const meanErr = angleDistance(mean, truth);

  assert.ok(medianErr <= 12, `mediana se fue ${medianErr}° del hablante`);
  assert.ok(
    medianErr <= meanErr,
    `la mediana (${medianErr}°) debería igualar o mejorar a la media (${meanErr}°)`,
  );
});

test('two people talking at once is reported as uncertain, not as a third person', () => {
  const rand = rng(11);
  // Overlapping turn: half the frames from one diner, half from another.
  const mixed = [...utterance(rand, 40, 12), ...utterance(rand, 200, 12)];
  const { angle, strength } = bearingOf(mixed);

  assert.ok(
    strength < 0.85,
    `R=${strength.toFixed(2)}: dos voces opuestas no deberían pasar por una sola`,
  );
  // And the answer a mean would have given is the empty space between them.
  assert.ok(
    angleDistance(angle, 120) > 25 || strength < 0.85,
    'el punto medio entre dos comensales no es un comensal',
  );
});

test('one person speaking is confident', () => {
  const rand = rng(3);
  const { strength } = bearingOf(utterance(rand, 300, 24));
  assert.ok(strength >= 0.85, `R=${strength.toFixed(2)} para una sola voz`);
});

test('a table of four stays four customers across a whole meal', () => {
  const rand = rng(23);
  const diners = [30, 120, 210, 300];
  const seats = new SeatMap();
  const seen = new Map();

  // Forty turns, going round the table and back again.
  for (let turn = 0; turn < 40; turn++) {
    const who = diners[turn % diners.length];
    const est = bearingOf(utterance(rand, who, 20));
    if (est.strength < 0.85) continue; // the session would skip it too
    const seat = seats.resolve(est.angle, est.strength);
    assert.ok(seat, 'una voz clara debería resolver a un asiento');
    const ids = seen.get(who) ?? new Set();
    ids.add(seat.id);
    seen.set(who, ids);
  }

  assert.equal(
    seats.list().length,
    diners.length,
    `mesa de ${diners.length} terminó con ${seats.list().length} clientes: ${JSON.stringify(seats.list())}`,
  );
  for (const [who, ids] of seen) {
    assert.equal(ids.size, 1, `el comensal en ${who}° quedó repartido en ${ids.size} clientes`);
  }
});

test('two seats that drift into each other become one customer again', () => {
  const seats = new SeatMap();

  // A first bearing lands 40° off the person's real position — far enough that
  // the map calls it a separate customer, which by its own definition it is.
  seats.resolve(100, 1);
  const ghost = seats.list().length;
  assert.equal(ghost, 1);

  // The real customer, and the estimate settling between the two.
  seats.resolve(140, 1);
  assert.equal(seats.list().length, 2, 'a 40° todavía son dos: eso es la definición');

  // As more turns arrive the stray seat is pulled toward where the person
  // actually is. Once the two are within merge distance they are one human,
  // and nothing used to notice.
  for (let i = 0; i < 8; i++) seats.resolve(122, 1);

  assert.equal(
    seats.list().length,
    1,
    `los asientos se juntaron y quedaron ${seats.list().length}: ${JSON.stringify(seats.list())}`,
  );
});

test('genuinely separate people are not folded together', () => {
  const seats = new SeatMap();
  for (let i = 0; i < 6; i++) {
    seats.resolve(90, 1);
    seats.resolve(180, 1);
  }
  assert.equal(seats.list().length, 2);
});
