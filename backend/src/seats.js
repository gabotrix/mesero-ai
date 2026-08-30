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
  /**
   * @param {number|null|undefined} angle degrees 0..359, or nullish if unknown
   * @param {number} [strength] how much the samples behind this angle agreed,
   *   0..1. A hesitant bearing still identifies a seat but is trusted less when
   *   moving that seat's own position, so one shaky turn cannot drag a
   *   customer who has been sitting still all evening.
   */
  resolve(angle, strength = 1) {
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
      // Later samples nudge less, so a seat settles; a weak bearing nudges
      // less still.
      const w = (1 / Math.min(best.samples, 8)) * Math.max(0, Math.min(1, strength));
      best.angle = blend(best.angle, angle, w);
      this.consolidate();
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

  /**
   * Folds together seats that have drifted into each other.
   *
   * One person can open two seats: their first bearing arrives noisy, lands
   * thirty degrees off, and a second seat is born a few turns later when the
   * estimate settles. Nothing used to close that gap, so a table of two showed
   * three customers for the rest of the evening and their dishes split between
   * two names.
   *
   * Merging keeps the seat with more samples — the one more likely to be where
   * the person actually is — and the lower id when they are level, so labels
   * stay stable rather than renumbering under the diner.
   */
  consolidate() {
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let i = 0; i < this.seats.length; i++) {
        for (let j = i + 1; j < this.seats.length; j++) {
          const a = this.seats[i];
          const b = this.seats[j];
          if (angleDistance(a.angle, b.angle) > MERGE_DEGREES) continue;
          const [keep, drop] =
            b.samples > a.samples || (b.samples === a.samples && b.id < a.id) ? [b, a] : [a, b];
          keep.angle = blend(keep.angle, drop.angle, drop.samples / (keep.samples + drop.samples));
          keep.samples += drop.samples;
          this.seats.splice(this.seats.indexOf(drop), 1);
          merged = true;
          break outer;
        }
      }
    }
  }

  list() {
    return this.seats.map((s) => ({ id: s.id, label: s.label, angle: s.angle }));
  }

  reset() {
    this.seats = [];
    this.nextId = 1;
  }
}
