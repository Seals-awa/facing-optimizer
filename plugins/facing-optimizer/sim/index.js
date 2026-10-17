// plugins/facing-optimizer/sim/index.js — 朝向优化 / facing optimizer (script plugin, sp:sdk@1).
//
// WHAT IT DOES (the request: 干员的朝向随目标敌人的位置变化，但只改模型). The MODEL of each single-target operator turns to
// face what it is fighting / healing; the operator itself keeps fighting exactly as the player deployed it. 朝向 in this
// sim is not decoration — an ally's attack range is its range grid ROTATED by `unit.dir` (server/sim/dir.js), and its
// blocks, pushes, knockbacks and every "前方 / 左右" effect read the same direction — so the plugin never touches
// `unit.dir`: it writes a DISPLAY-ONLY facing (`Battle.setViewDir`, server/sim/battle/queries.js) that only the client's
// model reads. The attack range, the skill ranges and the damage numbers are byte-for-byte the vanilla ones.
//
// WHO TURNS (the owner's rules):
//   * single-target attackers (普通攻击只打一个敌人) turn toward the enemy they attack;
//   * single-target healers (一次治疗一个: 医师 / 疗养师 / 行医 …) turn toward the ally they heal;
//   * 群攻 stays put — anything whose ordinary attack covers an area or several targets: splash (溅射), 范围内全体
//     (allInRange / 范围AOE), 同时攻击阻挡的所有敌人 (hitAllBlocked) and chain attacks (连锁);
//   * multi-target healers stay put — 群愈师 (mode 'multi') and 链愈师 (mode 'chain'), i.e. 一次奶 2 个以上;
//   * a unit with no normal attack (noAttack: 吟游者/阵法术师…) has nothing to face and never turns.
// Units the rules exclude get their display facing CLEARED, so they keep exactly the deployed direction.
//
// WHEN IT TURNS (the owner's second rule). Only a unit that HAS a target turns — a target means what the engine itself
// would attack (ai.js acquireTargets): the enemies it blocks (blocked first — they are hit even from outside the range
// grid, "阻挡了就一定要能打到") and then what its own attack (or heal) range reaches. A nearby enemy it can neither block
// nor reach is never faced, and a unit with nothing to hit keeps the facing it was deployed with.
//
// THE WIND-UP (the owner's fifth rule). Turning and striking do not land on the same frame: when the model has to turn
// for the swing it is about to make, that swing is HELD for the flip's length (FLIP_SECONDS ≈ 0.05 s, ~0.07 s of game
// time with the re-arm) and comes a couple of frames later — the operator is a little slower to strike and the model is
// already facing the enemy when it does. So a MELEE unit does not spin toward an enemy it cannot reach yet: it turns to
// the enemy it has just blocked and then hits it.
//
// AND NEVER INSIDE AN ANIMATION (the owner's third rule): the model turns BEFORE a swing or once everything is over.
// Frozen while the attack clip plays (`ATTACK_ANIM_TIME` after `lastAttackAt`), for the engine's own skill-animation
// window after a cast (`unit.skillAnimUntil`, 0.5 s), while a 群攻 skill holds its stance, and while the unit cannot act at
// all — 晕眩 / 冻结 / 浮空 (`unit.canAct` false) or 沉睡 (`flags.sleep`): a stunned operator keeps the facing it had, then
// turns when the stun wears off. Skill rules:
//   * a 群攻 skill (one that turns the ordinary attack into an area / multi-target one — 深巡's S1–S3 maxTargets 3,
//     拉普兰德's S1 maxTargets 2, a splash or chain stance): the model is sent back to the DEPLOYED facing the moment
//     the skill starts and stays there for the whole skill;
//   * every other skill lets the model keep turning — 宴's stats stance, 忍冬's 充能 S1 and 隐现's ammo magazine own no
//     stance the model would read as "facing this way" (the owner's rule: 无弹道近战 in a skill animation DOES turn).
// Turning BACK is slower still: after an attack the model holds the direction it shot in through the attack animation and
// `holdSeconds` more (3 s by default), so it does not flip between two shots.
//
// TURN FIRST, THEN SWING (the owner's fourth rule). Three places decide, in order of how early they are:
//   1. `enemySpawn` — in the tick's `spawns` phase, before anybody swings: a fresh enemy is faced at once;
//   2. the 0.05 s pulse — in the `scheduled` phase, before `attackCommit`, the move and the attacks;
//   3. `beforeAttack` — the engine's "about to attack" point, which fires BEFORE `lastAttackAt` and before the 'atk'
//      tuple of that swing, so even a target that only came into reach this very tick is faced ahead of the strike.
// The event stream therefore always carries the turn ahead of the attack it belongs to.
//
// THE FOUR DIRECTIONS: the model is drawn front / back (UP, "背向") or mirrored (LEFT), so the target's angle decides.
// It turns UP / DOWN only when the target is more than ~60° off the horizontal (|dRow| > tan60° · |dCol|): straight
// above at 90° yes, the 45° diagonal no — flatter targets stay LEFT / RIGHT.
//
// THE FLIP: every turn is announced with a transition length (`FLIP_SECONDS`, a fixed 0.05 s); the client sweeps the
// model's width to edge-on, swaps Front ⇄ Back there when the direction needs the other model, and opens it again the
// other way (render/units.js setViewDir / _startFlip) — a quick flick of the card, not a jump cut.
//
// Budget: 8000 script executions per plugin per battle (server/sim/content/dsl/budget.js), one per `every` callback —
// the fixed 0.05 s pulse is 20/s, i.e. ~6.5 minutes of game time (every field the game ships is well inside it). A
// longer battle only loses the cosmetic turning, nothing else; lower the rate by editing AIM_EVERY if a mode needs it.
//
// The plugin touches no data, no art and no official kit: one `sp.content.register({ install })` module.
import { kit, constants } from 'sp:sdk@1';

/** 'attack' frame of the sim (server/sim/constants.js): the model plays its attack clip this long after `lastAttackAt`. */
const ATTACK_ANIM = Number(constants.ATTACK_ANIM_TIME) > 0 ? Number(constants.ATTACK_ANIM_TIME) : 0.35;
/**
 * How often the facing is decided: a FIXED 0.05 s (1.5 sim ticks), fast enough that the model is already turned before
 * the swing it is about to make. The timer runs in the tick's `scheduled` phase — before `attackCommit`, the enemies'
 * move and the allies' attacks — so a target the engine is about to shoot is faced first.
 */
const AIM_EVERY = 0.05;
/**
 * FIXED length of a turn's transition, carried with every ['vdir', id, dir, seconds] tuple: the client sweeps the model
 * edge-on and back in this time (render/units.js _startFlip). 0.05 s reads as a snappy flick of the card.
 */
const FLIP_SECONDS = 0.05;

/**
 * The normalized settings this build understands (sp.settings holds the manifest's declared settings, defaults filled
 * in by shared/plugins/patch.js normalizeSettings). Anything missing or malformed falls back to the default.
 */
function readSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const hold = Number(s.holdSeconds);
  return {
    holdSeconds: Number.isFinite(hold) && hold >= 0 ? hold : 3,
    includeTokens: s.includeTokens === true,
  };
}

export default function setup(sp) {
  if (sp.settings && sp.settings.enabled === false) {
    sp.log('disabled by its settings: every model keeps the facing it was deployed with');
    return;
  }
  const cfg = readSettings(sp.settings);
  sp.log('aiming models every', AIM_EVERY, 's · flip', FLIP_SECONDS, 's · hold', cfg.holdSeconds, 's');

  sp.content.register({
    id: 'facing-optimizer',
    /** One module per battle (extensions.js installExtensions). */
    install(battle) {
      // an engine without the display channel has no cosmetic facing at all — and this plugin never changes the real
      // one, so there is nothing to fall back to
      if (typeof battle.setViewDir !== 'function') { sp.log('this engine has no Battle.setViewDir: nothing to do'); return; }
      const state = { turns: 0, held: new WeakMap() };
      // (one line in the server log per battle: whether the plugin ran, and whether anything was worth turning)
      battle.on('battleEnd', () => sp.log('facing-optimizer:', state.turns, 'model turns this battle'));
      // a skill starts: a 群攻 skill (深巡's S1–S3 `maxTargets: 3`, 拉普兰德's S1 `maxTargets: 2`, a chain / splash
      // stance) sends the model back to the DEPLOYED facing first and holds it there for the whole skill. That snap back
      // is INSTANT (no flip): the skill's own line / projectiles are fired along the deployed facing (its range grid is
      // rotated by `unit.dir`, which this plugin never touches), so the model must already be facing that way on the
      // first frame of the animation, not a flip later.
      battle.on('skillStart', (ctx) => {
        const u = ctx && ctx.unit;
        if (!u) return;
        if (skillIsAoe(ctx.skill) && battle.setViewDir(u, null, 0)) state.turns++;
      });
      // TURN FIRST, THEN SWING. `beforeAttack` is the engine's own "about to attack" point (ai.js performAttack): it
      // fires BEFORE `lastAttackAt` is stamped and before the 'atk' tuple of that swing. If the model has to turn for this
      // one, the swing is HELD for the flip's length instead of landing the same instant — the operator pays a small
      // wind-up delay (FLIP_SECONDS, ~0.07 s of game time) and strikes with the model already facing the enemy. That is
      // what makes a 近战干员 look right: it does not spin toward an enemy it cannot reach yet, it faces the one it is
      // about to hit, then hits it.
      battle.on('beforeAttack', (ctx) => {
        const u = ctx && ctx.attacker;
        const t = ctx && ctx.targets && ctx.targets[0];
        if (!u || !t || u.side !== 'ally' || !canTurn(u, cfg)) return;
        const now = Number(battle.time) || 0;
        if (animating(u, now)) return;
        if (!aimAt(battle, u, t)) return;               // already facing it: nothing to wait for
        state.turns++;
        // hold this swing: an empty list is the engine's "nothing to hit" (performAttack returns before the strike, the
        // 'atk' tuple and `lastAttackAt`), and the next tick's pulse re-arms the cooldown to the wind-up length. This
        // applies to a skill's strike too — the skill itself has already been cast by then, so nothing is lost.
        const held = state.held.get(u);
        if (held && held.target === t && now - held.at < 1) return;   // this target already got its wind-up: strike now
        state.held.set(u, { target: t, at: now });
        ctx.targets = [];
        battle.after(0, () => {
          if (!u.alive || !u.deployed) return;
          const cd = Number(u.atkCd);
          u.atkCd = Math.min(Number.isFinite(cd) ? cd : 0, FLIP_SECONDS);
        });
      });
      // a new enemy appears: aim now — this runs in the tick's `spawns` phase, still well before the allies attack, so a
      // fresh target is faced before anybody swings at it
      battle.on('enemySpawn', () => { state.turns += aimAll(battle, cfg, state); });
      // the pulse: a fixed 0.05 s, in the tick's `scheduled` phase — again BEFORE the enemies move and the allies attack,
      // so a model that has to re-aim has done it by the time the swing comes
      battle.every(AIM_EVERY, () => { state.turns += aimAll(battle, cfg, state); }, { immediate: true });
    },
  });
}

/**
 * Must the model hold the facing it has? The engine's own windows decide it, so the model freezes exactly as long as the
 * client is showing a clip of its own (`snapshot.js animOf`): the attack clip (`ATTACK_ANIM_TIME` after `lastAttackAt`),
 * the skill-animation window of a cast (`unit.skillAnimUntil`, skills.js — 0.5 s on EVERY activate) and a 群攻 skill's
 * stance (see skillHoldsStill). An INCAPACITATED unit holds its facing too: stunned / frozen / levitated (`unit.canAct` is
 * the engine's own gate and is false for all three — freeze and levitate set the `stun` flag) or asleep (no `stun` flag,
 * but it cannot act either).
 * A skill that does NOT change the attack into an area one does NOT hold the model: 宴 (its S1 is a stats stance), 忍冬's
 * 充能 S1 and 隐现's ammo magazine all keep turning — their skill animations do not hide the model.
 */
function animating(unit, now) {
  if (unit.canAct === false) return true;                             // 晕眩 / 冻结 / 浮空: cannot act at all
  const f = unit.s && unit.s.flags;
  if (f && f.sleep) return true;                                      // asleep sets no `stun` flag but is just as helpless
  if (now - lastAttackOf(unit) < ATTACK_ANIM) return true;             // the attack clip (snapshot.js animOf's window)
  if (Number(unit.skillAnimUntil) > now) return true;                 // the engine's own skill-animation window
  return skillHoldsStill(unit.skill);                                 // a 群攻 skill's stance (see below)
}

/**
 * Does the RUNNING skill hold a stance the model must not turn in? Only a **群攻 skill** does — one that turns the
 * ordinary attack into an area / multi-target one: 深巡's S1–S3 (`targeting.maxTargets: 3`), 拉普兰德's S1
 * (`maxTargets: 2`), 银灰 / 安洁莉娜 (`maxTargets: 4`), a splash or chain stance. The owner wants those to go back to the
 * DEPLOYED facing first (skillStart above) and stay there for the whole skill.
 * Every other skill leaves the model free to turn — 宴's stats stance, 忍冬's 充能 S1, 隐现's ammo magazine, a heal or a
 * plain attack buff: none of them owns a stance the model would read as "facing this way".
 */
function skillHoldsStill(skill) {
  if (!skill || !skill.active || skill.kind === 'passive') return false;
  return skillIsAoe(skill);
}

/** Does the skill make the attack hit an area or several targets (群攻技能)? Read off the skill's own spec overrides. */
function skillIsAoe(skill) {
  const spec = skill && skill.spec;
  if (!spec) return false;
  const a = spec.attack || null, t = spec.targeting || null;
  if (a) {
    if (Number(a.splashRadius) > 0) return true;
    if (Number(a.maxTargets) > 1) return true;
    if (a.allInRange === true || a.hitAllBlocked === true || a.rangeAoe === true) return true;
    if (a.chain) return true;
  }
  if (t) {
    if (Number(t.maxTargets) > 1) return true;
    if (t.allInRange === true || t.rangeAoe === true) return true;
  }
  return false;
}

/** May this unit's model turn at all — an ally on the field whose ordinary attack takes a single target? */
function canTurn(unit, cfg) {
  if (!unit || !unit.alive || !unit.deployed) return false;
  if (unit.kind !== 'op' && !(cfg.includeTokens && unit.kind === 'token')) return false;
  return turnMode(unit) !== null;
}

/** Re-aim every unit of the field that may turn; returns how many models it actually turned (one budget charge). */
function aimAll(battle, cfg, state) {
  const allies = battle.allyUnits;
  if (!allies || !allies.length) return 0;
  const now = Number(battle.time) || 0;
  let turns = 0;
  for (let i = 0; i < allies.length; i++) {
    const u = allies[i];
    if (u && (!u.alive || !u.deployed)) continue;               // knocked out / waiting to redeploy
    if (u && u.kind !== 'op' && !(cfg.includeTokens && u.kind === 'token')) continue;
    if (animating(u, now)) continue;                     // its own attack / skill animation: keep the facing
    const mode = u ? turnMode(u) : null;
    if (!mode) { if (u && battle.setViewDir(u, null)) turns++; continue; }   // 群攻 / 群奶 / 无普攻: deployed facing
    const t = targetOf(battle, u, mode);
    if (t) {
      if (aimAt(battle, u, t)) {
        turns++;
        // the swing this unit was about to make waits for the flip: a wind-up of FLIP_SECONDS. The pulse runs in the
        // tick's `scheduled` phase, i.e. before the cooldown is counted down and before the attack, so a unit that would
        // have swung this very tick (`atkCd` within one tick) is held for the flip — the strike then lands with the model
        // already facing the target instead of on the same frame as the turn.
        const dt = Number(battle.dt) > 0 ? Number(battle.dt) : 1 / 30;
        if (Number(u.atkCd) <= dt + 1e-9 && u.canAct) u.atkCd = FLIP_SECONDS;
      }
      continue;
    }
    // nothing it can reach: hold the direction it last shot in through the attack and `holdSeconds` after it, then
    // turn back to the deployed facing
    if (u.viewDir == null) continue;                            // already facing the deployed way
    if (now - lastAttackOf(u) < ATTACK_ANIM + cfg.holdSeconds) continue;
    if (battle.setViewDir(u, null, FLIP_SECONDS)) turns++;
  }
  return turns;
}

/** `unit.lastAttackAt` (sim/units.js; −Infinity before its first attack). */
function lastAttackOf(unit) {
  const t = Number(unit.lastAttackAt);
  return Number.isFinite(t) ? t : -Infinity;
}

/**
 * Point the model at `target`, with the fixed flip transition. False — no event, no flip — when already looking there.
 * The offset is taken from the two units' x / y (floats, never `tileR` / `tileC`: a walking enemy's tile fields are the
 * tile it spawned on) so a target standing right next to the unit still has a direction — a blocked enemy at a tile
 * corner reads as "up-right", not as the unit's own tile.
 */
function aimAt(battle, unit, target) {
  const dr = Number(target && target.y) - Number(unit && unit.y);
  const dc = Number(target && target.x) - Number(unit && unit.x);
  if (!Number.isFinite(dr) || !Number.isFinite(dc)) return false;
  const dir = dirToward(dr, dc);
  if (!dir || dir === (unit.viewDir || unit.dir)) return false;
  return battle.setViewDir(unit, dir, FLIP_SECONDS) === true;
}

/**
 * How `unit` turns — 'enemy' (its ordinary attack takes one enemy), 'ally' (its heal takes one ally), or null (its
 * model stays): the owner's rules, read off the resolved attack profile (professions.js resolveProfile).
 */
function turnMode(unit) {
  const p = unit.profile;
  if (!p || p.noAttack) return null;
  if (p.heal || p.dmgType === 'heal') return healTargetsOf(p) > 1 ? null : 'ally';   // 群愈师 / 链愈师 stay put
  if (p.splashRadius > 0) return null;            // 溅射 (群攻术师, 炮击手 …)
  if (p.allInRange || p.rangeAoe) return null;    // 攻击范围内全体 (收割者, 轰击术师, 阵法术师 …)
  if (p.hitAllBlocked) return null;               // 同时攻击阻挡的所有敌人 (强攻手 / 重剑手 / 推击手)
  if (p.chain) return null;                       // 连锁 (链术师 …)
  const n = Number(p.maxTargets);
  if (Number.isFinite(n) && n > 1) return null;   // 多目标
  return 'enemy';
}

/** How many targets one heal takes: 1 for a single-target healer, more for 群愈师 (multi) and 链愈师 (chain). */
function healTargetsOf(p) {
  const h = p.heal;
  if (!h) return 1;
  const n = Number(h.count);
  if (h.mode === 'multi' || h.mode === 'chain') return Number.isFinite(n) && n > 1 ? n : 3;
  return Number.isFinite(n) && n > 1 ? n : 1;
}

/**
 * What `unit` has to face right now, in the engine's own order (ai.js acquireTargets): the enemy it BLOCKS first — a
 * blocked enemy is attacked even when it stands outside the range grid — then the head of its range search; for a
 * healer, the first of its heal search. null = nothing it can reach.
 */
function targetOf(battle, unit, mode) {
  const p = unit.profile || {};
  if (mode === 'ally') {
    if (typeof battle.injuredAlliesInKeys !== 'function') return null;
    const list = battle.injuredAlliesInKeys(unit.rangeKeys, unit, !!(p.heal && p.heal.elementHealRatio));
    return list && list.length ? list[0] : null;
  }
  if (typeof battle.blockedTargets === 'function') {
    const blocked = battle.blockedTargets(unit, unit.profile || null);
    const pick = bestBlocked(battle, blocked);
    if (pick) return pick;
  }
  // kit.enemiesInGrid sorts with targeting.js sortEnemyTargets (blocked first → the profile's priority → taunt →
  // remaining route → spawn order), exactly the order the attack itself uses; `n: 1` keeps the head of it
  const foes = kit.enemiesInGrid(battle, unit, null, {
    n: 1,
    priority: p.priority || null,
    canHitFly: !!p.canHitFly,
    groundOnly: !!p.groundOnly,
  });
  if (foes && foes.length) return foes[0];
  return null;
}

/**
 * The blocked enemy the engine would take first: among the enemies `unit` blocks, the one nearest the goal, then the
 * earliest spawn — the tail of targeting.js sortEnemyTargets' key (taunt and the profile's priority are equal for the
 * enemies one unit blocks in practice), which keeps this pick and the attacked one the same so the model does not flip
 * between two of them.
 */
function bestBlocked(battle, blocked) {
  if (!blocked || !blocked.length) return null;
  let best = blocked[0];
  if (blocked.length === 1) return best;
  for (let i = 1; i < blocked.length; i++) {
    const e = blocked[i];
    const d = distanceOf(battle, e), bd = distanceOf(battle, best);
    if (d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && Number(e.spawnSeq) < Number(best.spawnSeq))) best = e;
  }
  return best;
}

/** `battle.remainingDistance` (tiles left on the enemy's route), Infinity when the engine cannot say. */
function distanceOf(battle, enemy) {
  if (typeof battle.remainingDistance !== 'function') return Infinity;
  const d = Number(battle.remainingDistance(enemy));
  return Number.isFinite(d) ? d : Infinity;
}

/**
 * The direction of a (dRow, dCol) offset to the target (floats — see aimAt). Two thresholds:
 *   * a target RIGHT NEXT to the unit (within a tile: what a 近战 blocks and hits) reads as above / below as soon as it
 *     is at least as far up as it is sideways — an enemy hugging the operator at the "up-right corner" is looked up at,
 *     which is the only angle a melee operator ever gets to show;
 *   * anything further away needs to be past TAN60 (≈60° off the horizontal) to turn the model up, as the owner asked:
 *     a 45° diagonal of a ranged operator's range stays LEFT / RIGHT.
 * UP is +row (row 0 is the board's bottom row, sim/dir.js), so "above" is a positive row delta.
 */
const TAN60 = 1.7320508075688772;   // tan(60°)
function dirToward(dr, dc) {
  const r = Number(dr) || 0, c = Number(dc) || 0;
  const ar = Math.abs(r), ac = Math.abs(c);
  if (ar < 1e-6 && ac < 1e-6) return null;                       // the same spot: no direction at all
  const close = Math.max(ar, ac) < 1 - 1e-6;                     // hugging the unit (a blocked enemy stands here)
  const vertical = close ? ar >= ac - 1e-9 : ar > TAN60 * ac;
  if (vertical) return r > 0 ? 'UP' : 'DOWN';
  return c > 0 ? 'RIGHT' : 'LEFT';
}
