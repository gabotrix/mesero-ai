/**
 * Turns a stream of arrival angles into stable customer identities.
 *
 * The array reports where a voice came from, not who it was. People at a table
 * do not move much, so clustering the azimuth is enough to tell "the person on
 * the left" from "the person across" — which is all that is needed to put the
 * right dish next to the right person when the food arrives.
 *
 * Deliberately not speaker recognition: no voice is stored, modelled or
 * compared. A seat is an angle and nothing else, and it is forgotten when the
 * table closes.
 */

/**
 * Two voices closer together than this are treated as the same person.
 *
 * Forty degrees merged neighbours at the same table into one customer. It is
 * tighter now that bearings are sampled while somebody is actually speaking
 * rather than whenever the model happened to answer.
 */
const MERGE_DEGREES = Number(process.env.SEAT_MERGE_DEGREES || 26);

/** Circular distance between two bearings, 0..180. */
export function angleDistance(a, b) {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

/** Circular mean, weighted, so a seat's bearing settles as it gets more samples. */
function blend(current, sample, weight) {
  const cur = (current * Math.PI) / 180;
  const smp = (sample * Math.PI) / 180;
  const x = Math.cos(cur) * (1 - weight) + Math.cos(smp) * weight;
  const y = Math.sin(cur) * (1 - weight) + Math.sin(smp) * weight;
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return Math.round((deg + 360) % 360);
}

export class SeatMap {
  constructor() {
    /** @type {{id:number, label:string, angle:number, samples:number}[]} */
    this.seats = [];
    this.nextId = 1;
  }

  /**
   * Resolves an angle to a seat, creating one the first time a direction is
   * heard from.
   * @param {number|null|undefined} angle degrees 0..359, or nullish if unknown
   * @returns {{id:number, label:string, angle:number}|null}
   */
  resolve(angle) {
    if (typeof angle !== 'number' || angle < 0 || angle > 359) return null;

    let best = null;
    let bestDist = Infinity;
    for (const seat of this.seats) {
      const d = angleDistance(seat.angle, angle);
      if (d < bestDist) {
        bestDist = d;
        best = seat;
      }
    }

    if (best && bestDist <= MERGE_DEGREES) {
      best.samples++;
      // Later samples nudge the bearing less, so a seat stops wandering.
      best.angle = blend(best.angle, angle, 1 / Math.min(best.samples, 8));
      return { id: best.id, label: best.label, angle: best.angle };
    }

    const seat = {
      id: this.nextId,
      label: `Cliente ${this.nextId}`,
      angle,
      samples: 1,
    };
    this.nextId++;
    this.seats.push(seat);
    return { id: seat.id, label: seat.label, angle: seat.angle };
  }

  list() {
    return this.seats.map((s) => ({ id: s.id, label: s.label, angle: s.angle }));
  }

  reset() {
    this.seats = [];
    this.nextId = 1;
  }
}
