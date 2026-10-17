// C4 simulation hosts (DESIGN §32.11). The clock belongs to runner.js. Only the vanilla host has a Battle on the page.
import { loadBrowserSim } from './simLoader.js';
import { unitStatsEntry } from '../../../shared/protocol.js';

/** [ASSUMED] 2 s per RPC, including construction and forceEnd (both can execute plugin hooks). */
export const WORKER_TIMEOUT_MS = 2000;
/** [ASSUMED] Trusted engine/module/data cold load can take longer; plugin code runs in a separate 2 s install RPC. */
export const WORKER_LOAD_TIMEOUT_MS = 15000;
const failure = (code, message) => Object.assign(new Error(message), { code });

export class InPageSimHost {
  constructor({ loadSim = loadBrowserSim } = {}) { this.loadSim = loadSim; this.remote = false; this.battle = null; }
  async load(cs = null, content = null) {
    this.sim = await this.loadSim(content ? { ...content, cs } : undefined);
    return this;
  }
  start(spec, opts = {}) {
    this.spec = spec;
    this.battle = this.sim.spec.createBattleFromSpec(spec, this.sim.ds, opts);
    this.meter = this.sim.spec.attachLpMeter(this.battle);
    return this;
  }
  step(n, { slice = 0 } = {}) {
    const b = this.battle;
    const slices = [];
    let ticks = 0;
    for (; ticks < n && !b.finished; ticks++) {
      b.step();
      if (slice && (ticks + 1) % slice === 0 && ticks + 1 < n) {
        const ev = b.drainEvents() || [];
        if (ev.length) slices.push({ gt: Number(b.time) || 0, ev });
      }
    }
    // Lazy reads keep the vanilla runner's snapshot/event timing unchanged.
    return { get snap() { return b.snapshot(); }, get ev() { return b.drainEvents() || []; }, state: b, ticks, slices };
  }
  progress() { return this.sim.spec.battleProgress(this.battle); }
  uniteLeft() { return this.sim.spec.uniteLeft(this.battle); }
  compactResult(options) {
    const s = this.sim.spec;
    const r = s.compactResult(this.battle.result());
    return typeof s.fitResult === 'function' ? s.fitResult(r, options) : r;
  }
  unitStats(id) {
    const u = this.battle?.unitById?.(id);
    return u ? unitStatsEntry(u, u._s || null) : null;
  }
  ownerOps(pid) {
    return (this.battle?.allyUnits || []).filter(u => u?.kind === 'op' && u.ownerId === pid && typeof u.defId === 'string').map(u => ({
      kind: 'op', ownerId: pid, defId: u.defId,
      ...(u.items?.length ? { items: [...u.items] } : {}),
      ...(u.def?.standInFor ? { standInFor: u.def.standInFor } : {}),
      ...(u.def?.diyFor && u.def.loadout?.diy ? { diy: { ...u.def.loadout.diy } } : {}),
    }));
  }
  syncPool(hp, acked) { this.battle?.sharedBoss?.sync?.(hp, acked); }
  forceEnd(reason) { this.battle?.forceEnd(reason); }
  stop() { this.battle = null; }
}

/** Wire state only: no engine import or engine object, including in the dev introspection hooks. */
export class WorkerSimHost {
  constructor({ workerFactory = () => new Worker(new URL('./simWorker.js', import.meta.url), { type: 'module' }),
    timeoutMs = WORKER_TIMEOUT_MS, loadTimeoutMs = WORKER_LOAD_TIMEOUT_MS, onFailure = () => {}, contentFor = null } = {}) {
    this.contentFor = contentFor;
    this.remote = true;
    this.timeoutMs = timeoutMs;
    this.loadTimeoutMs = loadTimeoutMs;
    this.onFailure = onFailure;
    this.worker = workerFactory();
    this.pending = new Map();
    this.seq = 0;
    this.stopped = false;
    this.failed = false;      // a worker that reported a failure is never parked for the next battle
    this.warmSince = 0;       // when it was parked (Date.now()), 0 = in use
    this.events = [];
    this.statsCache = new Map();
    this.statsPending = new Set();
    this.battle = {
      snapshot: () => this.packet?.snap,
      drainEvents: () => this.events.splice(0),
      fieldMeta: () => this.packet?.meta || { units: [] },
      getPlayer: pid => this.packet?.players?.[pid],
    };
    this.worker.onmessage = ({ data }) => {
      const p = this.pending.get(data?.id);
      if (!p) return;
      this.pending.delete(data.id);
      clearTimeout(p.timer);
      if (data.error) { const err = failure(data.error.code || 'PLUGIN_WORKER_FAILED', data.error.message); p.reject(err); this.fail(err); }
      else p.resolve(data.value);
    };
    this.worker.onerror = () => this.fail(failure('PLUGIN_WORKER_FAILED', 'simulation worker failed'));
    this.worker.onmessageerror = () => this.fail(failure('PLUGIN_WORKER_FAILED', 'simulation worker message failed'));
  }
  rpc(method, args = [], timeoutMs = this.timeoutMs) {
    if (this.stopped) return Promise.reject(failure('PLUGIN_WORKER_STOPPED', 'simulation worker stopped'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(failure('PLUGIN_WORKER_TIMEOUT', `simulation worker ${method} exceeded ${timeoutMs} ms`)), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker.postMessage({ id, method, args }); } catch (err) { this.fail(err); }
    });
  }
  fail(err) { if (this.stopped) return; this.failed = true; this.stop(err); this.onFailure(err); }
  async load(cs, content = null) {
    content ||= await this.contentFor?.(cs);
    if (!content || content.cs !== cs || !content.data) throw failure('PLUGIN_WORKER_FAILED', 'no checked content set');
    this.cs = cs;
    const ready = await this.rpc('load', [{ ...content, cs }], this.loadTimeoutMs);
    if (ready.install) await this.rpc('install');
    return this;
  }
  accept(packet) {
    this.packet = packet;
    this.events.push(...packet.ev);
    Object.assign(this.battle, packet.state);
    this.meter = packet.meter;
    return packet;
  }
  async start(spec) { this.spec = spec; this.accept(await this.rpc('start', [spec])); return this; }
  async step(n, opts) { return this.accept(await this.rpc('step', [n, opts])); }
  progress() { return this.packet.progress; }
  uniteLeft() { return this.packet.left; }
  compactResult() { return this.packet.result; }
  unitStats(id) {
    if (!this.stopped && !this.statsPending.has(id)) {
      this.statsPending.add(id);
      this.rpc('unitStats', [id]).then(v => this.statsCache.set(id, v), () => {}).finally(() => this.statsPending.delete(id));
    }
    return this.statsCache.get(id) || null;
  }
  ownerOps(pid) { return this.packet?.ops?.[pid] || []; }
  syncPool(hp, acked) { return this.rpc('syncPool', [hp, acked]).catch(() => {}); }
  async forceEnd(reason) { this.accept(await this.rpc('forceEnd', [reason])); }
  stop(err = failure('PLUGIN_WORKER_STOPPED', 'simulation worker stopped')) {
    if (this.stopped) return;
    this.stopped = true;
    this.worker.terminate();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }
  /**
   * Forget the battle that just ended but keep the boot: the engine is loaded, SES is locked down and the scripts are
   * installed, and `start(spec)` builds a fresh Battle on top. That boot is what costs 1–3 s on a phone, and the runner
   * builds a new worker for EVERY battle (a modded room runs the sim in a worker, a vanilla one in the page), so without
   * this a player pays it per battle. Only a cleanly finished battle is parked — `failWorker` still calls stop().
   */
  resetForNextBattle() {
    this.events.length = 0;
    this.statsCache.clear();
    this.statsPending.clear();
    this.packet = null;
    this.spec = null;
    this.meter = null;
    return this;
  }
}

// ---- warm workers: a finished battle leaves its boot behind for the next one ----------------------------------------
/**
 * One parked worker per content set. Reusing it skips the whole boot: the module Worker parses and instantiates the
 * engine (hundreds of modules), loads SES and locks the realm down, verifies and compiles the plugin sources — then
 * `start(spec)` is all the next battle needs. Keyed by `cs` because a worker may only ever load ONE content set
 * (simWorkerRuntime: "one content set per simulation worker").
 */
const WARM = new Map();
const MAX_WARM = 1;
/** [ASSUMED] a parked worker is dropped when the player has not started another battle for this long. */
export const WARM_TTL_MS = 180000;

/** Take the parked worker for `content set` and hand it the failure handler of the battle about to use it. */
export function takeWarmHost(cs, onFailure) {
  const host = WARM.get(cs);
  if (!host) return null;
  WARM.delete(cs);
  if (host.stopped || host.failed || !host.remote) { try { host.stop(); } catch { /* already gone */ } return null; }
  host.onFailure = onFailure || (() => {});
  host.warmSince = 0;
  return host;
}

/** Park a finished battle's worker for the next battle of the same content set (terminates any older parked one). */
export function parkHost(host, now = Date.now()) {
  if (!host || !host.remote || host.stopped || host.failed) { try { host?.stop(); } catch { /* ignore */ } return false; }
  const cs = host.cs;
  if (!cs) { try { host.stop(); } catch { /* ignore */ } return false; }
  host.onFailure = () => {};                 // a parked worker's failure must not fail the battle that left it
  host.resetForNextBattle();
  host.warmSince = now;
  for (const [key, old] of WARM) { if (key !== cs) { WARM.delete(key); try { old.stop(); } catch { /* ignore */ } } }
  while (WARM.size >= MAX_WARM) { const [key, old] = WARM.entries().next().value; WARM.delete(key); try { old.stop(); } catch { /* ignore */ } }
  WARM.set(cs, host);
  return true;
}

/** Drop parked workers that are stale (the player left the room, or started no battle for a long while). */
export function pruneWarmHosts(now = Date.now()) {
  for (const [cs, host] of WARM) {
    if (host.stopped || host.failed || now - (host.warmSince || 0) > WARM_TTL_MS) {
      WARM.delete(cs);
      try { host.stop(); } catch { /* ignore */ }
    }
  }
}

/** Terminate every parked worker (the runner was disposed). */
export function drainWarmHosts() {
  for (const host of WARM.values()) { try { host.stop(); } catch { /* ignore */ } }
  WARM.clear();
  warming = null;
}

/** How many workers are parked right now (tests / diagnostics). */
export function warmHostCount() { return WARM.size; }

/**
 * Boot a worker for `cs` in the background while a battle of that content set is already running, and park it — the next
 * battle then starts without the boot (engine modules, SES lockdown, plugin install), which is the 1–3 s a phone spends
 * on every modded battle. A finished battle keeps its own worker for its result screen, so this is the only way one can
 * be free in time. `onPrewarmed` runs after a successful boot (tests / diagnostics).
 */
let warming = null;
export function prewarmHost(cs, content, { onPrewarmed = null, workerFactory = undefined } = {}) {
  if (!cs || !content || WARM.has(cs) || warming === cs) return false;
  warming = cs;
  let host;
  try { host = new WorkerSimHost(workerFactory ? { workerFactory } : {}); } catch { warming = null; return false; }
  host.load(cs, content).then(() => {
    if (warming === cs) warming = null;
    if (!parkHost(host)) { try { host.stop(); } catch { /* ignore */ } return; }
    try { onPrewarmed?.(host); } catch { /* a diagnostic hook must not break the prewarm */ }
  }, () => {
    if (warming === cs) warming = null;
    try { host.stop(); } catch { /* ignore */ }
  });
  return true;
}

/** Is a background boot in flight for `cs`? (tests / diagnostics) */
export function prewarming(cs) { return warming === cs; }
