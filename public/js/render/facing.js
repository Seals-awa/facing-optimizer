// Operator model facing (owner request, upstream #730): an operator's MODEL turns toward the target it is attacking and
// goes back to its deployed direction once the attack animation is over and no further attack follows.
//
// Display only. `dir` is the deploy direction: it rotates the attack range, decides which model is drawn (Front / Back,
// research 07 §5.5) and drives every directional effect — none of that moves here. The renderer already receives every
// attack (`['atk', attacker, target, kind]`) and every unit's position, so the model can be turned from what the snapshot
// says, without asking the sim for it.
//
// This module is the plan the renderer follows (render/app.js windUpAttacks → UnitView.faceTarget):
//   * **one attack = one group.** A group is the attacks of ONE source stamped at ONE event time (one sim tick), not
//     "everything inside the look-ahead window": a fast single-target attacker fires several attacks inside the window, and
//     counting those as one area attack was the reported bug. An area attack's hits share the tick, so they land in one
//     group.
//   * **an attack with more than one DISTINCT target is 群攻 (area) → no turn at all**, not even for its first target: an
//     area attacker's targets differ every swing, so a turn would flicker. Two hits on the SAME target (a 连击 in one tick)
//     are still a single-target attack.
//   * the turn happens when the attack ANIMATION starts (render/app.js turns right after the wind-up was accepted), never
//     before it was accepted.
//   * no turn while the operator is stunned / frozen / asleep (`UnitView.statuses`), and none for an enemy: the stun clip
//     plays in the facing the model already had.
//   * the model goes back to the deployed direction when the attack animation is over and no next attack is coming.
//
// The turnaround itself is the official one: skeleton + mirror + animation, 0.15 s (render/units.js `_startTurn`).
export const FACING_TURN_S = 0.15;      // 换骨架 + 镜像 + 换动画 takes this long, in GAME seconds (the model's own clock)

/** Direction names as the sim / renderer spell them (UP is +row: the board's "up" is a bigger row). */
const UP = 'UP', DOWN = 'DOWN', LEFT = 'LEFT', RIGHT = 'RIGHT';

// --- the official direction test (the operator's rule, reconstructed from the client's own chain) ---------------------
// The client's `_SetFourDirection` picks a direction from the target offset with these thresholds; `faceToBack` is simply
// "the direction is Up" (see `UnitView._wantsBack` / `_wantsBackFor`).
/** Horizontal / vertical tolerance of the four-direction test (TOLERANCE). */
export const FACING_TOLERANCE = 0.2;
/** The extra band added to it (ADDON): past TOLERANCE + ADDON tiles sideways the model stays level. */
export const FACING_ADDON = 0.25;
/** Closer than this (in tiles) the client judges no direction at all and keeps the facing the model has. */
export const FACING_TOO_CLOSE = 0.25;
/** Both offsets below this are "no direction". */
export const FACING_ZERO = 0.01;

/**
 * The direction to draw a model in for a target offset (dx = right, dy = up, in tiles) — the operator's rule:
 *
 *   1. `dx² + dy² < 0.25²` → too close: no direction, the model keeps the facing it has;
 *   2. both `|dx|` and `|dy|` below 0.01 → no direction;
 *   3. horizontal first: `|dx| >= TOLERANCE + ADDON` (0.45 tiles) is level — LEFT / RIGHT;
 *   4. otherwise the narrow band around vertical: `|dy| > |dx|` is UP / DOWN; a target that is wider than it is tall stays
 *      level even inside the band.
 *
 * So "up" is a narrow strip straight above / below (sideways offset under 0.45 tiles), not a 45° cone, and a target that
 * hugs the unit (< 0.25 tiles) turns nothing — which is why turning up is rarely seen in game.
 *
 * [ASSUMED] step 3's exact form: the client compares `|dx|` against `TOLERANCE + ADDON` (the alternative reading applies
 * one constant per axis). The owner's description — "the up band is ±0.2–0.45 tiles, and only when the vertical offset is
 * larger" — is what this implements.
 *
 * @param {number} dx
 * @param {number} dy
 * @returns {'UP'|'DOWN'|'LEFT'|'RIGHT'|null} null = no direction (keep the facing)
 */
export function facingDir(dx, dy) {
  const c = Number(dx) || 0, r = Number(dy) || 0;
  const ac = Math.abs(c), ar = Math.abs(r);
  if (ac * ac + r * r < FACING_TOO_CLOSE * FACING_TOO_CLOSE) return null;      // too close: keep the facing
  if (ac < FACING_ZERO && ar < FACING_ZERO) return null;                       // no direction
  if (ac >= FACING_TOLERANCE + FACING_ADDON) return c > 0 ? RIGHT : LEFT;      // far enough sideways: level
  if (ar > ac) return r > 0 ? UP : DOWN;                                       // the narrow up / down band
  return c > 0 ? RIGHT : LEFT;
}

/** The direction to draw for one unit attacking another (both `{ x, y }` in tiles), or null. */
export function facingToward(unit, target) {
  if (!unit || !target) return null;
  return facingDir(Number(target.x) - Number(unit.x), Number(target.y) - Number(unit.y));
}

/** Attack kinds whose "source" is the previous target of a bounce, not an attacker (render/app.js CHAIN_KINDS). */
const BOUNCE = new Set(['chain', 'chainHeal']);

/** Live-facing states in which the official client keeps the model exactly as it is (its stun clip plays in place). */
export const HELD_FACING = ['stun', 'sleep', 'freeze'];

// --- the per-ability face modes (10-face-modes.json, generated into render/faceModes.js) -------------------------------
// Every operator's facing is not one rule: the official client stores, per ability animation, how the model is driven
// while that animation plays. The flags below are the parts of that table this renderer uses.
//   Target            turn the model toward the target of the attack (the default)
//   none              never turn (the animation plays in whatever facing the model has)
//   Default           keep the deployed facing while the clip plays
//   Front             never use the Back model, even when facing up (mirror only)
//   ForceToDirection  play the direction-specific clip (row `up` / `down`) instead of turning
//   FirstCastTarget   keep facing the first target the clip was cast at
//   CheckDownAttack   with FirstCastTarget: a target below plays the `down` clip
/**
 * The flags of a table `mode` string (`'Default+ForceToDirection'` → `{ default: true, forceDir: true, … }`).
 * @param {string} mode
 * @returns {{ target: boolean, none: boolean, def: boolean, front: boolean, forceDir: boolean, firstCast: boolean, checkDown: boolean }}
 */
export function faceModeFlags(mode) {
  const m = String(mode || 'Target');
  const has = (k) => m === k || m.split('+').includes(k);
  const target = has('Target');
  return {
    target,
    none: has('none'),
    def: has('Default'),
    front: has('Front'),
    forceDir: has('ForceToDirection'),
    firstCast: has('FirstCastTarget'),
    checkDown: has('CheckDownAttack'),
  };
}

/**
 * The table row that drives a given clip: an exact `animKey` match wins, then the ability's default row (`animKey: ''`),
 * so a skill animation uses that operator's own default when the table has no row for its exact clip.
 * @param {any[][]|undefined|null} rows the operator's rows (`FACE_MODES[charId]`)
 * @param {string} [clip] the clip playing now (SpineActor.current)
 * @returns {any[]|null}
 */
export function faceModeRow(rows, clip) {
  return faceModeFor(rows, [clip]);
}

/**
 * The row that drives the clip set running now, from a list of candidate animation names in priority order: the first exact
 * match wins, then the ability default (`animKey: ''`). Several candidates are needed because the official table names the
 * CLIP of an ability 鈥?a skill's row may be `Skill_2` while the loop that actually plays is `Skill_2_Loop` (閲庨瑑 S2), and an
 * attack row may name `Attack` while the clip is `Attack_A`.
 * @param {any[][]|undefined|null} rows the operator's rows (FACE_MODES[charId])
 * @param {string[]} candidates animation names, most specific first
 * @returns {any[]|null}
 */
export function faceModeFor(rows, candidates, wantKind = '', opts = {}) {
  if (!Array.isArray(rows) || !rows.length) return null;
  let fallback = null;
  for (const row of rows) {
    if (Array.isArray(row) && !row[0] && !fallback) { fallback = row; break; }
  }
  // More than one ability can name the SAME animation with different modes (char_1052_kalts2's Skill_3_Attack is both
  // `FirstCastTarget+CheckDownAttack` and `Target`): collect every match and pick the row whose kind is what is running,
  // instead of letting the first row win.
  const pick = (list) => {
    if (!list.length) return null;
    let pool = list;
    if (wantKind) {
      const byKind = pool.filter((r) => String(r[5] || '') === wantKind);
      if (byKind.length) pool = byKind;
    }
    if (pool.length > 1) {
      // the same animation driven by two abilities of one kind: a `FirstCastTarget` row is the ability's FIRST attack,
      // so it drives the first attack of the running skill and the plain row the later ones (char_1052_kalts2 S3).
      const isFirst = (r) => /FirstCastTarget/.test(String(r[1] || ''));
      const first = pool.find(isFirst);
      const later = pool.find((r) => !isFirst(r));
      if (opts.firstCast === true && first) return first;
      if (opts.firstCast === false && later) return later;
      return first || later;
    }
    return pool[0];
  };
  for (const cand of candidates) {
    const name = String(cand || '').toLowerCase();
    if (!name) continue;
    const hits = rows.filter((row) => Array.isArray(row) && String(row[0]).toLowerCase() === name);
    const hit = pick(hits);
    if (hit) return hit;
  }
  // soft match: a row whose animKey is a prefix of a candidate (Skill_2 covers Skill_2_Loop), longest row key first
  const list = candidates.map((c) => String(c || '')).filter(Boolean);
  let best = [];
  for (const row of rows) {
    if (!Array.isArray(row) || !row[0]) continue;
    for (const cand of list) {
      if (cand === row[0] || cand.startsWith(row[0] + '_')) {
        if (!best.length || row[0].length > best[0][0].length) best = [row];
        else if (row[0].length === best[0][0].length) best.push(row);
      }
    }
  }
  return pick(best) || fallback;
}

/**
 * Plan the look-ahead window: every queued event in ascending time order, with the ATTACKS grouped by **one attack** and
 * the area ones marked.
 *
 * One group = one source at one event time (one sim tick). More than one distinct target inside a group means the attack
 * hit several units at once (群攻) — its model must not turn, including its first target.
 *
 * Non-attack events (`skill` on/off, `fx`, …) are part of the plan so the renderer can read them in order — the official
 * cast effects of a wind-up need the skill state just before its attack. They carry `group: null` and `multi: false`.
 *
 * @param {{ forEachUpcoming: (from: number, to: number, fn: (ev: any[], t: number) => void) => void }} interp the
 *   interpolation buffer (render/interp.js SnapshotBuffer)
 * @param {number} from
 * @param {number} to
 * @returns {{ ev: any[], t: number, group: string|null, multi: boolean }[]} ascending by time
 */
export function attackGroups(interp, from, to) {
  const seen = new Map();                       // group key -> Set of distinct target ids
  const list = [];
  interp.forEachUpcoming(from, to, (ev, t) => {
    if (!Array.isArray(ev) || ev[1] == null) return;
    if (ev[0] !== 'atk' || (ev[3] != null && BOUNCE.has(ev[3]))) {
      // not this unit's own attack: a skill toggle rides along, a bounce belongs to the previous target
      list.push({ ev, t, group: null, multi: false });
      return;
    }
    const group = `${ev[1]}|${t}`;
    let targets = seen.get(group);
    if (!targets) seen.set(group, (targets = new Set()));
    if (ev[2] != null) targets.add(ev[2]);
    list.push({ ev, t, group, multi: false });
  });
  for (const entry of list) if (entry.group) entry.multi = (seen.get(entry.group)?.size ?? 0) > 1;
  return list;
}
