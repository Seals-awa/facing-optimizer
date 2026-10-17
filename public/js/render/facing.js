// 干员模型朝向 (owner request): the MODEL of an operator turns toward the target it is attacking, and back to its
// deployed direction a few seconds after the last attack. It is display-only: `dir` and the attack range never move.
//
// This is the CLIENT-SIDE version of the 朝向优化 plugin. The plugin needed the sim (a script plugin), and a room with any
// script plugin runs its battle in a module Worker that boots the engine + SES + the plugin sources for EVERY battle —
// on a phone that is the 1–3 s delay a modded battle shows on entry. Doing it here costs nothing: the renderer already
// receives every attack (`['atk', attacker, target, kind]`) and every unit's position, so the model can be turned from
// what the snapshot says.
//
// Rules (the owner's, as far as the client can see them):
//   * an operator's model turns to the target it hits; `dir` / range / targeting are untouched,
//   * no turn while the operator is stunned/frozen/asleep (`UnitView.statuses`),
//   * no turn for a multi-target attack (群攻): several hits from one operator in a frame leave the model alone,
//   * the model turns back to the deployed direction AFTER the attack and after HOLD seconds of not attacking.
export const FACING_FLIP_S = 0.05;      // the flip transition, seconds (see UnitView.setViewDir)
export const FACING_HOLD_S = 3;         // keep the facing this long after the last attack

/** Direction names as the sim / renderer spell them (UP is +row, the board's "up" is a bigger row). */
const DIRECTIONS = ['UP', 'DOWN', 'LEFT', 'RIGHT'];
const UP = DIRECTIONS[0], DOWN = DIRECTIONS[1], LEFT = DIRECTIONS[2], RIGHT = DIRECTIONS[3];

/**
 * The direction to draw a model in for a target offset (dx = right, dy = up, in tiles). Vertical only past ~60° off the
 * horizontal — the owner's rule ("敌人在上方约 >60° 才朝上转"): a 45° diagonal keeps the model level. A target that hugs the
 * unit (a blocked enemy within a tile) reads as vertical as soon as it is at least as far up/down as sideways: that is the
 * only angle a melee operator ever shows.
 * @param {number} dx
 * @param {number} dy
 * @returns {'UP'|'DOWN'|'LEFT'|'RIGHT'|null} null when the target is on the unit's own tile
 */
export function facingDir(dx, dy) {
  const c = Number(dx) || 0, r = Number(dy) || 0;
  const ac = Math.abs(c), ar = Math.abs(r);
  if (ac < 1e-6 && ar < 1e-6) return null;
  const close = Math.max(ac, ar) < 1 - 1e-6;
  const vertical = close ? ar >= ac - 1e-9 : ar > 1.7320508075688772 * ac;   // tan 60°
  if (vertical) return r > 0 ? UP : DOWN;
  return c > 0 ? RIGHT : LEFT;
}

/** The direction to draw for one unit attacking another (both `{ x, y }` in tiles), or null. */
export function facingToward(unit, target) {
  if (!unit || !target) return null;
  return facingDir(Number(target.x) - Number(unit.x), Number(target.y) - Number(unit.y));
}
