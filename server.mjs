// AOS-1 reference server: static ui/, GET /api/state, POST /api/control, in-process heartbeat loop.
// Zero dependencies, Node 18+ ESM. Binds 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  paths, loadConfig, loadState, saveState, loadHeartbeat, atomicWrite, appendEvent, readEvents,
  runTick, abortAll, backoffDelayS, TERMINAL,
} from './heartbeat/tick.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const P = paths(ROOT);
const UI = path.join(ROOT, 'ui');
const PORT = (() => { const n = Number(process.env.PORT); return Number.isInteger(n) && n > 0 && n < 65536 ? n : 4317; })();
const HOST = '127.0.0.1';
const MAX_BODY = 8 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2' };
const HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

// ---------- heartbeat loop ----------
let timer = null;

function schedule() {
  clearTimeout(timer); timer = null;
  const hb = loadHeartbeat(ROOT);
  const goal = loadState(ROOT).goal;
  if (!goal || TERMINAL.has(goal.status) || hb.status === 'stopped') return;
  const cfg = loadConfig(ROOT);
  const delayMs = backoffDelayS(cfg.interval_s, hb.consecutive_errors) * 1000;
  const due = (hb.ts ? Date.parse(hb.ts) : 0) + delayMs;
  const wait = Math.max(500, due - Date.now()); // after a restart, resume from the last beat
  timer = setTimeout(() => { try { runTick(ROOT); } catch (e) { console.error('tick failed:', e); } schedule(); }, wait);
  timer.unref?.();
}

function recoverOnStart() {
  const { goal } = loadState(ROOT);
  if (!goal) return;
  const hb = loadHeartbeat(ROOT);
  if (TERMINAL.has(goal.status)) { if (hb.status !== 'stopped') atomicWrite(P.hb, { ...hb, status: 'stopped' }); }
  else if (hb.status === 'stopped') atomicWrite(P.hb, { ...hb, status: 'running' });
}

// ---------- API ----------
function liveness(hb) {
  const age = hb.ts ? (Date.now() - Date.parse(hb.ts)) / 1000 : Infinity;
  const i = hb.interval_s || 60;
  return { age_s: Number.isFinite(age) ? Math.round(age * 10) / 10 : null,
    liveness: age < 1.5 * i ? 'alive' : age < 3 * i ? 'late' : 'dead' };
}

function getState() {
  const st = loadState(ROOT);
  const hb = loadHeartbeat(ROOT);
  const cfg = loadConfig(ROOT);
  return { goal: st.goal, tasks: st.tasks, agents: st.agents,
    heartbeat: { ...hb, ...liveness(hb) },
    events: readEvents(ROOT, 200),
    server_time: new Date().toISOString(),
    mode: cfg.dispatch_command ? 'command' : 'simulated' };
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function control(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be a JSON object');
  const { action } = body;
  if (!['pause', 'resume', 'cancel', 'note'].includes(action)) throw new HttpError(400, 'action must be pause|resume|cancel|note');
  let text = null;
  if (action === 'note') {
    if (typeof body.text !== 'string') throw new HttpError(400, 'note requires string "text"');
    text = body.text.trim();
    if (!text || text.length > 1000) throw new HttpError(400, 'note text must be 1-1000 characters');
  }
  const st = loadState(ROOT);
  const goal = st.goal;
  if (!goal) throw new HttpError(409, 'no goal');
  const hb = loadHeartbeat(ROOT);
  const ev = (type, data = {}, actor = 'human') => appendEvent(ROOT, { type, actor, goal_id: goal.id, data });
  const terminal = TERMINAL.has(goal.status);
  if (action !== 'note' && terminal) throw new HttpError(409, `goal is ${goal.status}`);
  const ts = new Date().toISOString();

  if (action === 'note') {
    ev('human.note', { text });
  } else if (action === 'pause') {
    if (hb.status === 'paused') throw new HttpError(409, 'already paused');
    ev('human.pause');
    atomicWrite(P.hb, { ...hb, status: 'paused' });
  } else if (action === 'resume') {
    if (hb.status !== 'paused' && goal.status !== 'blocked') throw new HttpError(409, 'not paused or blocked');
    ev('human.resume');
    if (goal.status === 'blocked') {
      goal.status = 'active'; delete goal.blocked_reason; goal.updated_at = ts;
      ev('goal.updated', { status: 'active', reason: 'resumed by human' });
      saveState(ROOT, st);
    }
    atomicWrite(P.hb, { ...hb, status: 'running', ts, consecutive_errors: 0 });
  } else if (action === 'cancel') {
    ev('human.cancel');
    abortAll();
    const cancelled = [];
    for (const t of st.tasks) if (!['done', 'failed', 'cancelled'].includes(t.status)) { t.status = 'cancelled'; t.updated_at = ts; cancelled.push(t.id); }
    for (const a of st.agents) if (a.status === 'running') { a.status = 'idle'; a.current_task = null; }
    goal.status = 'cancelled'; goal.updated_at = ts;
    ev('goal.cancelled', { cancelled_tasks: cancelled }, 'orchestrator');
    saveState(ROOT, st);
    atomicWrite(P.hb, { ...hb, status: 'stopped' });
  }
  schedule();
  return getState();
}

// ---------- HTTP ----------
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function hostAllowed(req) {
  const ok = (h) => /^(127\.0\.0\.1|localhost)$/.test(h);
  try {
    if (!ok(new URL('http://' + (req.headers.host || '')).hostname)) return false;
    if (req.headers.origin && !ok(new URL(req.headers.origin).hostname)) return false;
    return true;
  } catch { return false; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, { error: 'bad path' }); }
  if (rel.includes('\0') || rel.includes('\\')) return send(res, 400, { error: 'bad path' });
  if (rel.split('/').some((s) => s.startsWith('.'))) return send(res, 404, { error: 'not found' });
  let file = path.resolve(UI, '.' + rel);
  if (file !== UI && !file.startsWith(UI + path.sep)) return send(res, 403, { error: 'forbidden' });
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    const real = fs.realpathSync(file);
    const realUi = fs.realpathSync(UI);
    if (!real.startsWith(realUi + path.sep)) return send(res, 403, { error: 'forbidden' });
    const stat = fs.statSync(real);
    res.writeHead(200, { ...HEADERS, 'Content-Type': MIME[path.extname(real).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(real).pipe(res);
  } catch { send(res, 404, { error: 'not found' }); }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!hostAllowed(req)) return send(res, 403, { error: 'forbidden host' });
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/api/state') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
      return send(res, 200, getState());
    }
    if (pathname === '/api/control') {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'content-type must be application/json' });
      return send(res, 200, { ok: true, state: control(await readBody(req)) });
    }
    if (pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
    return serveStatic(req, res, pathname);
  } catch (e) {
    if (e instanceof HttpError) { if (!res.headersSent) send(res, e.status, { error: e.message }); }
    else { console.error(e); if (!res.headersSent) send(res, 500, { error: 'internal error' }); }
  }
});

recoverOnStart();
server.listen(PORT, HOST, () => {
  console.log(`AOS-1 dashboard on http://${HOST}:${PORT}  (interval ${loadConfig(ROOT).interval_s}s)`);
  schedule();
});

const shutdown = () => { clearTimeout(timer); abortAll(); server.close(); setTimeout(() => process.exit(0), 200).unref(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
