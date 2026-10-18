// AOS-1 heartbeat tick (SPEC section 4). Zero dependencies, Node 18+ ESM.
// Usage: `node heartbeat/tick.mjs` runs one tick; server.mjs imports runTick().
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TERMINAL = new Set(['achieved', 'failed', 'cancelled']);
const MAX_BACKOFF_S = 900; // 15 min

export const paths = (root = ROOT) => ({
  goal: path.join(root, 'state', 'goal.json'),
  tasks: path.join(root, 'state', 'tasks.json'),
  agents: path.join(root, 'state', 'agents.json'),
  hb: path.join(root, 'state', 'heartbeat.json'),
  events: path.join(root, 'state', 'events.ndjson'),
  lock: path.join(root, 'state', '.tick.lock'),
  config: path.join(root, 'heartbeat', 'config.json'),
});

const nowIso = () => new Date().toISOString();

export function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function atomicWrite(file, obj) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function loadConfig(root = ROOT) {
  const d = { interval_s: 10, stall_after_s: 120, max_parallel: 2, dispatch_command: null,
    dispatch_timeout_s: 600, sim_ticks_to_done: 2, sim_cost_usd: 0.25 };
  const c = { ...d, ...(readJSON(paths(root).config, {}) || {}) };
  for (const k of ['interval_s', 'stall_after_s', 'max_parallel', 'dispatch_timeout_s', 'sim_ticks_to_done']) {
    if (!Number.isFinite(c[k]) || c[k] <= 0) c[k] = d[k];
  }
  if (!Number.isFinite(c.sim_cost_usd) || c.sim_cost_usd < 0) c.sim_cost_usd = d.sim_cost_usd;
  if (typeof c.dispatch_command !== 'string' || !c.dispatch_command.trim()) c.dispatch_command = null;
  return c;
}

export const backoffDelayS = (interval, errors) =>
  Math.min(interval * 2 ** Math.min(errors || 0, 20), MAX_BACKOFF_S);

// ---------- events ----------
function lastEventSeq(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const { size } = fs.fstatSync(fd);
      const len = Math.min(size, 65536);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try { return JSON.parse(lines[i]).seq | 0; } catch { /* partial line */ }
      }
    } finally { fs.closeSync(fd); }
  } catch { /* none yet */ }
  return 0;
}

export function appendEvent(root, e) {
  const P = paths(root);
  const ev = { ts: nowIso(), seq: lastEventSeq(P.events) + 1, type: e.type, actor: e.actor || 'orchestrator',
    goal_id: e.goal_id ?? null, task_id: e.task_id ?? null, data: e.data || {} };
  fs.appendFileSync(P.events, JSON.stringify(ev) + '\n');
  return ev;
}

export function readEvents(root, limit = 200) {
  try {
    const file = paths(root).events;
    const fd = fs.openSync(file, 'r');
    try {
      const { size } = fs.fstatSync(fd);
      const len = Math.min(size, 1024 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      let lines = buf.toString('utf8').split('\n');
      if (len < size) lines = lines.slice(1); // drop partial first line
      const out = [];
      for (const l of lines) { if (l) { try { out.push(JSON.parse(l)); } catch { /* skip */ } } }
      return out.slice(-limit);
    } finally { fs.closeSync(fd); }
  } catch { return []; }
}

// ---------- state ----------
export function loadState(root = ROOT) {
  const P = paths(root);
  return { goal: readJSON(P.goal), tasks: readJSON(P.tasks, []), agents: readJSON(P.agents, []) };
}
export function saveState(root, st) {
  const P = paths(root);
  atomicWrite(P.tasks, st.tasks);
  atomicWrite(P.agents, st.agents);
  atomicWrite(P.goal, st.goal);
}
export function loadHeartbeat(root = ROOT) {
  return { seq: 0, ts: null, interval_s: 10, status: 'running', liveness: 'alive', last_tick_ms: 0,
    consecutive_errors: 0, ...(readJSON(paths(root).hb, {}) || {}) };
}

// ---------- lock ----------
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function acquireLock(root, ttlMs) {
  const file = paths(root).lock;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const l = readJSON(file, null);
      const stale = !l || !pidAlive(l.pid) || Date.now() - l.ts > ttlMs;
      if (!stale) return false;
      try { fs.unlinkSync(file); } catch { /* raced */ }
    }
  }
  return false;
}
function releaseLock(root) {
  const file = paths(root).lock;
  const l = readJSON(file, null);
  if (l && l.pid === process.pid) { try { fs.unlinkSync(file); } catch { /* gone */ } }
}

// ---------- dispatch (pluggable) ----------
const children = new Map(); // task_id -> { child, timer, done }

export function abortAll() {
  for (const [, c] of children) { clearTimeout(c.timer); c.done = true; try { c.child.kill('SIGTERM'); } catch { /* dead */ } }
  children.clear();
}

function completeTask(st, t, cfg, result, ev) {
  t.status = 'done'; t.updated_at = nowIso(); t.result = result;
  const a = st.agents.find((x) => x.id === t.assignee);
  if (a) { a.status = 'idle'; a.current_task = null; a.last_event_at = t.updated_at; }
  const cost = cfg.dispatch_command ? 0 : cfg.sim_cost_usd;
  st.goal.budget.spent_usd = Math.round(((st.goal.budget.spent_usd || 0) + cost) * 1e4) / 1e4;
  ev('task.completed', t.assignee, t.id, { result });
}

function failAttempt(st, t, cause, ev, type = 'task.failed') {
  t.updated_at = nowIso();
  const a = st.agents.find((x) => x.id === t.assignee);
  if (a) { a.status = type === 'task.stalled' ? 'stalled' : 'errored'; a.current_task = null; a.last_event_at = t.updated_at; }
  ev(type, t.assignee, t.id, { cause, attempts: t.attempts });
  if (t.attempts < t.max_attempts) {
    t.status = 'ready';
    ev('task.retried', 'orchestrator', t.id, { attempts: t.attempts, max_attempts: t.max_attempts });
  } else {
    t.status = 'failed';
    if (type === 'task.stalled') ev('task.failed', 'orchestrator', t.id, { cause, attempts: t.attempts });
  }
}

function spawnTask(root, cfg, goal, task) {
  const child = spawn(cfg.dispatch_command, { shell: true, cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const rec = { child, done: false, out: '', err: '', timer: null };
  const cap = (s, d) => (s + d).slice(-4096);
  child.stdout.on('data', (d) => { rec.out = cap(rec.out, d); });
  child.stderr.on('data', (d) => { rec.err = cap(rec.err, d); });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ task, goal: { id: goal.id, title: goal.title, description: goal.description }, root }));
  rec.timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* dead */ } }, cfg.dispatch_timeout_s * 1000);
  const finish = (code, sig, spawnErr) => {
    if (rec.done) return;
    rec.done = true; clearTimeout(rec.timer); children.delete(task.id);
    try { finishTask(root, cfg, task.id, code, sig, rec, spawnErr); } catch { /* next tick reaps */ }
  };
  child.on('error', (e) => finish(-1, null, e.message));
  child.on('close', (code, sig) => finish(code, sig));
  children.set(task.id, rec);
}

function finishTask(root, cfg, taskId, code, sig, rec, spawnErr) {
  const st = loadState(root);
  if (!st.goal || TERMINAL.has(st.goal.status)) return;
  const t = st.tasks.find((x) => x.id === taskId);
  if (!t || t.status !== 'running') return;
  const ev = (type, actor, task_id, data) => appendEvent(root, { type, actor, goal_id: st.goal.id, task_id, data });
  if (code === 0) completeTask(st, t, cfg, (rec.out.trim() || 'exit 0').slice(0, 1000), ev);
  else failAttempt(st, t, spawnErr || `exit ${code}${sig ? ` signal ${sig}` : ''}: ${rec.err.trim().slice(-500)}`, ev);
  saveState(root, st);
}

// ---------- the tick ----------
let inTick = false;

export function runTick(root = ROOT) {
  const P = paths(root);
  const cfg = loadConfig(root);
  const goal0 = readJSON(P.goal);
  if (!goal0) return { skipped: 'no-goal' };
  let hb = loadHeartbeat(root);

  if (TERMINAL.has(goal0.status)) {
    if (hb.status !== 'stopped') atomicWrite(P.hb, { ...hb, status: 'stopped' });
    return { stopped: true, goal: goal0.status };
  }
  if (hb.status === 'stopped') return { stopped: true };

  const ttl = Math.max(60, cfg.interval_s * 5) * 1000;
  if (inTick || !acquireLock(root, ttl)) {
    appendEvent(root, { type: 'heartbeat.skipped', goal_id: goal0.id, data: { seq: hb.seq, reason: 'previous tick still running' } });
    return { skipped: 'overlap' };
  }
  inTick = true;
  const t0 = Date.now();
  try {
    hb = loadHeartbeat(root);
    if (hb.status === 'paused') { // pause takes effect at tick boundary: keep beating, do no work
      atomicWrite(P.hb, { ...hb, ts: nowIso(), interval_s: cfg.interval_s, liveness: 'alive' });
      return { paused: true };
    }
    return doTick(root, cfg, hb, t0);
  } catch (err) {
    const h = loadHeartbeat(root);
    h.consecutive_errors = (h.consecutive_errors || 0) + 1;
    h.last_tick_ms = Date.now() - t0;
    atomicWrite(P.hb, h);
    appendEvent(root, { type: 'heartbeat.tick', goal_id: goal0.id,
      data: { seq: h.seq, ok: false, error: String(err && err.message || err), consecutive_errors: h.consecutive_errors,
        next_delay_s: backoffDelayS(cfg.interval_s, h.consecutive_errors) } });
    return { error: String(err && err.message || err) };
  } finally {
    inTick = false;
    releaseLock(root);
  }
}

function doTick(root, cfg, hb, t0) {
  const P = paths(root);
  const now = Date.now();

  // 1. Beat
  const expectedMs = backoffDelayS(cfg.interval_s, hb.consecutive_errors) * 1000;
  const gap = hb.ts ? now - Date.parse(hb.ts) : 0;
  const seq = hb.seq + 1;
  hb = { ...hb, seq, ts: new Date(now).toISOString(), interval_s: cfg.interval_s, status: 'running', liveness: 'alive' };
  atomicWrite(P.hb, hb);

  // 2. Observe
  const st = loadState(root);
  const goal = st.goal;
  const gid = goal.id;
  const ev = (type, actor, task_id, data) => appendEvent(root, { type, actor, goal_id: gid, task_id, data });
  if (hb.ts && seq > 1 && gap > 1.5 * expectedMs) {
    ev(gap > 3 * expectedMs ? 'heartbeat.dead' : 'heartbeat.late', 'orchestrator', null, { gap_s: Math.round(gap / 1000), expected_s: expectedMs / 1000 });
  }
  const recent = readEvents(root, 500);
  goal.budget = goal.budget || {};
  const sum = { started: [], completed: [], stalled: [], created: [], ready: [] };
  const evMark = (type, actor, task_id, data) => { // track summary while emitting
    if (type === 'task.completed') sum.completed.push(task_id);
    if (type === 'task.stalled') sum.stalled.push(task_id);
    return ev(type, actor, task_id, data);
  };

  // 3. Reap
  for (const t of st.tasks) {
    if (t.status !== 'running' || children.has(t.id)) continue;
    let last = Date.parse(t.updated_at) || 0;
    for (const e of recent) if (e.task_id === t.id) last = Math.max(last, Date.parse(e.ts) || 0);
    if (now - last > cfg.stall_after_s * 1000) failAttempt(st, t, `no event within ${cfg.stall_after_s}s`, evMark, 'task.stalled');
  }

  // 4. Verify
  let terminal = false;
  const tById = new Map(st.tasks.map((t) => [t.id, t]));
  for (const c of goal.success_criteria || []) {
    if (!Array.isArray(c.requires) || !c.requires.length) continue;
    const met = c.requires.every((id) => tById.get(id)?.status === 'done');
    if (met !== !!c.met) { c.met = met; ev('goal.updated', 'orchestrator', null, { criterion: c.id, met }); }
  }
  const crit = goal.success_criteria || [];
  if (goal.status === 'active' && crit.length && crit.every((c) => c.met)) {
    goal.status = 'achieved'; terminal = true;
    ev('goal.achieved', 'orchestrator', null, { criteria: crit.length });
  }

  if (!terminal && goal.status === 'active') {
    // 5. Plan
    for (const t of st.tasks) {
      if (t.status === 'pending' && (t.depends_on || []).every((d) => tById.get(d)?.status === 'done')) {
        t.status = 'ready'; t.updated_at = nowIso(); sum.ready.push(t.id); ev('task.ready', 'orchestrator', t.id, {});
      }
    }
    const live = st.tasks.filter((t) => ['ready', 'running', 'needs_review'].includes(t.status));
    if (!live.length) {
      let created = 0;
      for (const c of crit.filter((x) => !x.met)) {
        if (st.tasks.some((t) => t.planned_for === c.id) || !st.agents.length) continue;
        const load = (a) => st.tasks.filter((t) => t.assignee === a.id).length;
        const agent = [...st.agents].sort((a, b) => load(a) - load(b))[0];
        const id = `t-${st.tasks.length + 1}`;
        const ts = nowIso();
        const t = { id, goal_id: gid, title: `Address criterion ${c.id}: ${c.text}`.slice(0, 200), assignee: agent.id,
          status: 'ready', depends_on: [], attempts: 0, max_attempts: 3, inputs: { criterion: c.id },
          output_contract: `Evidence that criterion ${c.id} is met`, acceptance: [c.text], artifacts: [],
          planned_for: c.id, created_at: ts, updated_at: ts };
        st.tasks.push(t); tById.set(id, t);
        c.requires = [...(c.requires || []), id];
        sum.created.push(id); created++;
        ev('task.created', 'orchestrator', id, { planned_for: c.id, assignee: agent.id });
      }
      const stuck = !created && !st.tasks.some((t) => ['ready', 'running', 'needs_review'].includes(t.status));
      if (stuck) {
        goal.status = 'blocked'; goal.blocked_reason = 'No viable tasks toward unmet criteria';
        ev('goal.blocked', 'orchestrator', null, { reason: goal.blocked_reason });
      }
    }
  }

  if (!terminal && goal.status === 'active') {
    // 6. Dispatch
    const sim = !cfg.dispatch_command;
    const started = new Set();
    if (sim) {
      for (const t of st.tasks) {
        if (t.status !== 'running') continue;
        t.sim_ticks = (t.sim_ticks || 0) + 1; t.updated_at = nowIso();
        const a = st.agents.find((x) => x.id === t.assignee); if (a) a.last_event_at = t.updated_at;
        if (t.sim_ticks >= cfg.sim_ticks_to_done) completeTask(st, t, cfg, `Simulated completion of "${t.title}"`, evMark);
      }
    }
    let slots = cfg.max_parallel - st.tasks.filter((t) => t.status === 'running').length;
    for (const t of st.tasks) {
      if (slots <= 0) break;
      if (t.status !== 'ready') continue;
      const a = st.agents.find((x) => x.id === t.assignee);
      if (!a || a.status === 'running') continue; // one task per agent: write scopes never overlap
      t.status = 'running'; t.attempts = (t.attempts || 0) + 1; t.sim_ticks = 0; t.updated_at = nowIso();
      a.status = 'running'; a.current_task = t.id; a.last_event_at = t.updated_at;
      slots--; started.add(t.id); sum.started.push(t.id);
      ev('task.started', a.id, t.id, { attempt: t.attempts, mode: sim ? 'simulated' : 'command' });
      if (!sim) spawnTask(root, cfg, goal, t);
    }

    // 7. Budget check
    const b = goal.budget;
    const overTicks = Number.isFinite(b.max_ticks) && seq > b.max_ticks;
    const overUsd = Number.isFinite(b.max_usd) && (b.spent_usd || 0) > b.max_usd;
    if (overTicks || overUsd) {
      goal.status = 'blocked';
      goal.blocked_reason = overTicks ? `Tick budget exceeded (${seq} > ${b.max_ticks})` : `Spend budget exceeded ($${b.spent_usd} > $${b.max_usd})`;
      ev('budget.exceeded', 'orchestrator', null, { ticks: seq, spent_usd: b.spent_usd || 0, max_ticks: b.max_ticks, max_usd: b.max_usd });
      ev('goal.blocked', 'orchestrator', null, { reason: goal.blocked_reason });
    }
  }

  goal.updated_at = nowIso();
  saveState(root, st);

  // 8. Emit
  const counts = {};
  for (const t of st.tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  const ms = Date.now() - t0;
  hb = { ...loadHeartbeat(root), last_tick_ms: ms, consecutive_errors: 0 };
  if (terminal) hb.status = 'stopped';
  atomicWrite(P.hb, hb);
  ev('heartbeat.tick', 'orchestrator', null, { seq, ok: true, ms, goal_status: goal.status, tasks: counts,
    mode: cfg.dispatch_command ? 'command' : 'simulated', ...sum });
  return { seq, goal_status: goal.status, tasks: counts, ms };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(runTick(ROOT)));
}
