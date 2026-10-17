// Attack-clip pacing for a unit view (render/units.js): the actor's attack clip is stretched over the unit's attack
// interval, so a wrong interval is visible as a **slow-motion** (or rushed) swing — which is what an operator showed at the
// start of a battle: the view started from a base-record guess (`bat × 100 / aspd`, no buffs) and only the measured gap
// between two attacks pulled it to the truth.
//
// The snapshot now carries the unit's real interval (`UnitInfo.atkInterval` = sim `s.interval`, buffs included), and the
// first measured gap replaces the estimate outright, so the very first swing is already paced right.
export const ATK_MIN_S = 0.2;      // a sane lower bound (6 attacks / s)
export const ATK_MAX_S = 6;        // and upper bound, as the old guess clamps
export const ATK_DEFAULT_S = 1.2;  // nothing known at all
export const ATK_SANE_S = [0.05, 6]; // a measured gap outside this is a stall (a hidden tab, a reconnect), not a rhythm

/** Clamp an attack interval into what the renderer can show. NaN → ATK_DEFAULT_S. */
export function clampAtkInterval(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return ATK_DEFAULT_S;
  return Math.min(ATK_MAX_S, Math.max(ATK_MIN_S, n));
}

/**
 * The interval a view starts from: the snapshot's own value (authoritative — the sim resolved it with buffs), else the
 * base-record guess (`guess`), else ATK_DEFAULT_S. `null` / undefined / 0 fall through.
 * @param {number|null|undefined} snapshotValue `UnitInfo.atkInterval`
 * @param {number|null|undefined} guess the `bat × 100 / aspd` of the operator's record
 */
export function startAtkInterval(snapshotValue, guess) {
  const s = Number(snapshotValue);
  if (Number.isFinite(s) && s > 0) return clampAtkInterval(s);
  const g = Number(guess);
  if (Number.isFinite(g) && g > 0) return clampAtkInterval(g);
  return ATK_DEFAULT_S;
}

/**
 * The interval to use after `measured` seconds between two attacks of one unit. The first real measurement wins outright
 * (the estimate is forgotten), later ones move 40 % toward the measurement (`0.6 × prev + 0.4 × measured`) — the long-run
 * behaviour of the shipped renderer. A gap outside ATK_SANE_S is ignored (keeps `prev`).
 * @param {number} prev current interval
 * @param {number} measured seconds between the last two attacks
 * @param {boolean} hasMeasured whether an earlier sane gap was already applied
 * @returns {{ interval: number, measured: boolean }} measured = true when this gap was usable
 */
export function nextAtkInterval(prev, measured, hasMeasured) {
  const d = Number(measured);
  const [lo, hi] = ATK_SANE_S;
  if (!Number.isFinite(d) || d <= lo || d >= hi) return { interval: clampAtkInterval(prev), measured: false };
  const next = hasMeasured ? clampAtkInterval(prev * 0.6 + d * 0.4) : clampAtkInterval(d);
  return { interval: next, measured: true };
}
