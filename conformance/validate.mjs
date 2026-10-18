#!/usr/bin/env node
// AOS-1 conformance validator. Zero dependencies, Node 18+.
// Usage: node conformance/validate.mjs [stateDir=./state] [--selftest]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = path.join(HERE, '..', 'schemas');

// ---------- mini JSON Schema validator (type, required, enum, properties, items, pattern, minimum, minItems) ----------
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}
function typeMatches(v, t) {
  const a = typeOf(v);
  return a === t || (t === 'number' && a === 'integer');
}
export function validateSchema(value, schema, at = '$', errs = []) {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      errs.push(`${at}: expected ${types.join('|')}, got ${typeOf(value)}`);
      return errs;
    }
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value)))
    errs.push(`${at}: ${JSON.stringify(value)} not in enum [${schema.enum.join(', ')}]`);
  if (schema.pattern !== undefined && typeof value === 'string' && !new RegExp(schema.pattern).test(value))
    errs.push(`${at}: "${value}" does not match /${schema.pattern}/`);
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum)
    errs.push(`${at}: ${value} < minimum ${schema.minimum}`);
  if (schema.minItems !== undefined && Array.isArray(value) && value.length < schema.minItems)
    errs.push(`${at}: needs at least ${schema.minItems} item(s)`);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required || []) if (!(k in value)) errs.push(`${at}: missing required property "${k}"`);
    for (const [k, s] of Object.entries(schema.properties || {})) if (k in value) validateSchema(value[k], s, `${at}.${k}`, errs);
  }
  if (Array.isArray(value) && schema.items) value.forEach((it, i) => validateSchema(it, schema.items, `${at}[${i}]`, errs));
  return errs;
}

// ---------- helpers ----------
const schemas = {};
for (const n of ['goal', 'task', 'agent', 'heartbeat', 'event'])
  schemas[n] = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, `${n}.schema.json`), 'utf8'));

const TERMINAL_GOAL = new Set(['achieved', 'failed', 'cancelled']);

export function validateState(dir) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const readJson = (name) => {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) { err(`${name}: file missing`); return undefined; }
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { err(`${name}: invalid JSON (${e.message})`); return undefined; }
  };
  const schemaCheck = (label, v, s) => validateSchema(v, s, '$').forEach((m) => err(`${label}: ${m}`));

  // goal
  const goal = readJson('goal.json');
  if (goal !== undefined) {
    schemaCheck('goal.json', goal, schemas.goal);
    if (goal && typeof goal === 'object') {
      const b = goal.budget;
      if (!b || typeof b !== 'object' || !(b.max_ticks !== undefined || b.max_usd !== undefined || b.max_wall_clock_s !== undefined))
        err('goal.json: budget is mandatory and must set at least one of max_ticks, max_usd, max_wall_clock_s (SPEC 7)');
    }
  }

  // tasks
  const tasks = readJson('tasks.json');
  const taskIds = new Set();
  if (tasks !== undefined) {
    if (!Array.isArray(tasks)) err('tasks.json: must be an array');
    else {
      tasks.forEach((t, i) => {
        schemaCheck(`tasks.json[${i}]${t && t.id ? ` (${t.id})` : ''}`, t, schemas.task);
        if (t && typeof t.id === 'string') {
          if (taskIds.has(t.id)) err(`tasks.json: duplicate task id "${t.id}"`);
          taskIds.add(t.id);
        }
      });
      for (const t of tasks) {
        if (!t || typeof t !== 'object') continue;
        for (const d of Array.isArray(t.depends_on) ? t.depends_on : [])
          if (!taskIds.has(d)) err(`tasks.json: task "${t.id}" depends_on unknown task "${d}"`);
        if (goal && goal.id && t.goal_id !== undefined && t.goal_id !== goal.id)
          err(`tasks.json: task "${t.id}" goal_id "${t.goal_id}" != goal id "${goal.id}"`);
        if (Number.isInteger(t.attempts) && Number.isInteger(t.max_attempts) && t.attempts > t.max_attempts)
          err(`tasks.json: task "${t.id}" attempts (${t.attempts}) exceeds max_attempts (${t.max_attempts})`);
      }
      // cycle detection (DFS, colors)
      const byId = new Map(tasks.filter((t) => t && t.id).map((t) => [t.id, t]));
      const color = new Map();
      const stack = [];
      const visit = (id) => {
        color.set(id, 1); stack.push(id);
        for (const d of (byId.get(id)?.depends_on) || []) {
          if (!byId.has(d)) continue;
          if (color.get(d) === 1) { err(`tasks.json: dependency cycle: ${[...stack.slice(stack.indexOf(d)), d].join(' -> ')}`); }
          else if (!color.get(d)) visit(d);
        }
        stack.pop(); color.set(id, 2);
      };
      for (const id of byId.keys()) if (!color.get(id)) visit(id);
    }
  }

  // agents
  const agents = readJson('agents.json');
  const agentIds = new Set();
  if (agents !== undefined) {
    if (!Array.isArray(agents)) err('agents.json: must be an array');
    else {
      agents.forEach((a, i) => {
        schemaCheck(`agents.json[${i}]${a && a.id ? ` (${a.id})` : ''}`, a, schemas.agent);
        if (a && typeof a.id === 'string') {
          if (agentIds.has(a.id)) err(`agents.json: duplicate agent id "${a.id}"`);
          agentIds.add(a.id);
        }
      });
      for (const a of agents) {
        if (a && a.current_task && Array.isArray(tasks) && !taskIds.has(a.current_task))
          err(`agents.json: agent "${a.id}" current_task "${a.current_task}" does not exist`);
      }
      if (Array.isArray(tasks))
        for (const t of tasks)
          if (t && t.assignee && !agentIds.has(t.assignee))
            err(`tasks.json: task "${t.id}" assignee "${t.assignee}" not in agents.json`);
    }
  }

  // heartbeat
  const hb = readJson('heartbeat.json');
  if (hb !== undefined) {
    schemaCheck('heartbeat.json', hb, schemas.heartbeat);
    if (hb && typeof hb === 'object' && typeof hb.ts === 'string' && typeof hb.interval_s === 'number') {
      const ts = Date.parse(hb.ts);
      if (Number.isNaN(ts)) err(`heartbeat.json: ts "${hb.ts}" is not a parseable timestamp`);
      else if (hb.status === 'running') {
        const age = (Date.now() - ts) / 1000;
        const derived = age < 1.5 * hb.interval_s ? 'alive' : age < 3 * hb.interval_s ? 'late' : 'dead';
        // Stored liveness is written at beat time (always fresh). Claiming late/dead while the beat is fresh is inconsistent.
        const rank = { alive: 0, late: 1, dead: 2 };
        if (hb.liveness && rank[hb.liveness] > rank[derived])
          err(`heartbeat.json: liveness "${hb.liveness}" inconsistent with age ${age.toFixed(0)}s at interval ${hb.interval_s}s (derived "${derived}")`);
        if (derived !== 'alive')
          warnings.push(`heartbeat.json: heartbeat is ${derived} (age ${age.toFixed(0)}s, interval ${hb.interval_s}s) - runner may not be running`);
      }
    }
    if (hb && goal && TERMINAL_GOAL.has(goal.status) && hb.status === 'running')
      err(`heartbeat.json: goal is terminal ("${goal.status}") but heartbeat status is "running" (SPEC 3: terminal states MUST stop the Heartbeat)`);
  }

  // events
  const evPath = path.join(dir, 'events.ndjson');
  const events = [];
  if (!fs.existsSync(evPath)) err('events.ndjson: file missing');
  else {
    const raw = fs.readFileSync(evPath, 'utf8');
    if (raw.length && !raw.endsWith('\n')) warnings.push('events.ndjson: no trailing newline (possible partial write)');
    let prevSeq = null;
    raw.split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      const n = i + 1;
      let e;
      try { e = JSON.parse(line); } catch (x) { err(`events.ndjson:${n}: unparseable line (${x.message})`); return; }
      validateSchema(e, schemas.event, '$').forEach((m) => err(`events.ndjson:${n}: ${m}`));
      if (e && Number.isInteger(e.seq)) {
        if (prevSeq !== null && e.seq <= prevSeq) err(`events.ndjson:${n}: seq ${e.seq} is not greater than previous seq ${prevSeq} (must increase monotonically)`);
        prevSeq = e.seq;
      }
      if (e && e.task_id && Array.isArray(tasks) && !taskIds.has(e.task_id))
        warnings.push(`events.ndjson:${n}: task_id "${e.task_id}" not found in tasks.json`);
      events.push(e);
    });
    if (events.length === 0) warnings.push('events.ndjson: empty (a goal.created event is expected, SPEC 7: all state changes traceable)');
  }

  return { errors, warnings };
}

// ---------- CLI ----------
function report(label, { errors, warnings }) {
  for (const w of warnings) console.log(`  warn: ${w}`);
  for (const e of errors) console.log(`  FAIL: ${e}`);
  console.log(`${errors.length ? 'NOT CONFORMANT' : 'OK'} ${label} (${errors.length} violation(s), ${warnings.length} warning(s))`);
}

function selftest() {
  const root = path.join(HERE, 'fixtures');
  let bad = 0;
  const run = (kind, dir) => {
    const name = path.basename(dir);
    const r = validateState(dir);
    // fixtures use fixed old timestamps; ignore nothing - heartbeat status in fixtures is paused/stopped
    const ok = kind === 'valid' ? r.errors.length === 0 : r.errors.length > 0;
    console.log(`${ok ? 'pass' : 'FAIL'} ${kind}/${name}${kind === 'invalid' && r.errors[0] ? `  -> ${r.errors[0]}` : ''}`);
    if (!ok) { bad++; if (kind === 'valid') r.errors.forEach((e) => console.log(`    ${e}`)); }
  };
  for (const kind of ['valid', 'invalid']) {
    const kd = path.join(root, kind);
    if (!fs.existsSync(kd)) continue;
    for (const d of fs.readdirSync(kd).sort()) if (fs.statSync(path.join(kd, d)).isDirectory()) run(kind, path.join(kd, d));
  }
  console.log(bad ? `selftest: ${bad} fixture(s) behaved wrongly` : 'selftest: all fixtures behaved as expected');
  return bad ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) process.exit(selftest());
  const dir = path.resolve(args[0] || './state');
  if (!fs.existsSync(dir)) { console.error(`state dir not found: ${dir}`); process.exit(2); }
  const r = validateState(dir);
  report(dir, r);
  process.exit(r.errors.length ? 1 : 0);
}
