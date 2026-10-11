// Records real runs from the local dashboard server so the hosted site (Vercel, no server) can replay them.
// Output: bulwark/dashboard/demo/<target>/{meta.json, run.json, loop.json, replay/*.json, diff/*.json, artifacts/*}
//
//   PORT=5419 npm run dashboard &   # in another terminal (or let this script start it)
//   node scripts/record-hosted-demo.mjs            # record everything (runs both loops, ~20 min)
//   node scripts/record-hosted-demo.mjs --replays  # re-capture only the replays/diffs of the recorded runs
//
// Event streams keep their timing (ms since the request started), so the hosted app plays at real speed.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT ?? 5419);
const BASE = `http://localhost:${PORT}`;
const OUT = 'bulwark/dashboard/demo';
// TARGETS=refundbot re-records one target and keeps the others.
const TARGETS = (process.env.TARGETS ?? 'refundbot,researchbot').split(',');
// The app's defaults: 20 trials, seed 42, memory off, SLO 95%, no tournament.
const RUN_Q = 'trials=20&seed=42';
const LOOP_Q = 'trials=20&seed=42&memory=0&slo=0.95';

const key = (q) => createHash('sha1').update(q).digest('hex').slice(0, 16);

async function up() {
  try { return (await fetch(`${BASE}/api/meta`)).ok; } catch { return false; }
}

async function stream(path) {
  const t0 = Date.now();
  const res = await fetch(BASE + path);
  const events = [];
  let buf = '';
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? '';
      events.push({ t: Date.now() - t0, event, data: JSON.parse(data) });
    }
  }
  return events;
}

// Every {fault, seed[, run, ws]} the app can open a replay for: walk all event payloads.
function trialRefs(events) {
  const refs = new Map();
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    if (typeof v.fault === 'string' && v.seed !== undefined && typeof v.seed !== 'object') {
      const r = { fault: v.fault, seed: String(v.seed) };
      if (v.run && v.ws) Object.assign(r, { run: v.run, ws: v.ws });
      refs.set(JSON.stringify(r), r);
    }
    Object.values(v).forEach(walk);
  };
  events.forEach((e) => walk(e.data));
  return [...refs.values()];
}

// The replay modal clips every step payload to 150 characters and reads only a few observation fields,
// so big payloads (a Crustdata company record is ~100 KB) are cut to a prefix that renders identically.
const OBS_KEEP = ['seed', 'outcome', 'error', 'durationMs', 'steps', 'faultsFired', 'refunds'];

// A copy of v whose JSON starts with the same `budget` characters as v's.
function prefix(v, budget) {
  if (typeof v === 'string') return v.length > budget ? v.slice(0, budget) + '…' : v;
  if (!v || typeof v !== 'object') return v;
  const arr = Array.isArray(v), out = arr ? [] : {};
  let used = 1;
  for (const [k, x] of Object.entries(v)) {
    if (used > budget) break;
    const y = prefix(x, budget - used - (arr ? 0 : k.length + 3));
    if (arr) out.push(y); else out[k] = y;
    used += JSON.stringify(y ?? null).length + 1 + (arr ? 0 : k.length + 3);
  }
  return out;
}

export function compact(v, key = '') {
  if (Array.isArray(v)) {
    if (key === 'timeline') return v.map((step) => (step && typeof step === 'object'
      ? Object.fromEntries(Object.entries(step).map(([k, x]) => [k, JSON.stringify(x ?? null).length > 1000 ? prefix(x, 600) : x]))
      : step));
    return v.map((x) => compact(x));
  }
  if (v && typeof v === 'object') {
    if (key === 'observation') return Object.fromEntries(OBS_KEEP.filter((k) => k in v).map((k) => [k, v[k]]));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, compact(x, k)]));
  }
  if (typeof v === 'string' && v.length > 4000) return v.slice(0, 4000) + '…';
  return v;
}

async function getJson(path) {
  const res = await fetch(BASE + path);
  return { status: res.status, body: compact(await res.json()) };
}

async function recordReplays(dir, targetName, runId, run, loop) {
  rmSync(join(dir, 'replay'), { recursive: true, force: true });
  rmSync(join(dir, 'diff'), { recursive: true, force: true });
  mkdirSync(join(dir, 'replay'), { recursive: true });
  mkdirSync(join(dir, 'diff'), { recursive: true });
  const refs = [...trialRefs(run), ...trialRefs(loop)];
  console.log(`${targetName}: ${refs.length} trial replays…`);
  let diffs = 0;
  for (const r of refs) {
    const q = new URLSearchParams({ fault: r.fault, seed: r.seed, target: targetName });
    if (r.run && r.ws) { q.set('run', r.run); q.set('ws', r.ws); }
    writeFileSync(join(dir, 'replay', key(q.toString()) + '.json'), JSON.stringify(await getJson('/api/replay?' + q)));
    const dq = new URLSearchParams({ fault: r.fault, seed: r.seed, target: targetName, run: runId, ws: `${r.fault}-accepted` });
    const dk = key(dq.toString());
    if (!existsSync(join(dir, 'diff', dk + '.json'))) {
      const d = await getJson('/api/diff?' + dq);
      if (d.status === 200) { writeFileSync(join(dir, 'diff', dk + '.json'), JSON.stringify(d)); diffs++; }
    }
  }
  return { replays: refs.length, diffs };
}

async function startServer() {
  if (await up()) return undefined;
  const server = spawn('npx', ['tsx', 'bulwark/server.ts'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore', detached: true });
  for (let i = 0; i < 60 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
  return () => process.kill(-server.pid);
}

async function main() {
  const stop = await startServer();
  const indexPath = join(OUT, 'index.json');
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : { targets: {} };
  index.recordedAt = new Date().toISOString();

  for (const target of TARGETS) {
    const dir = join(OUT, target);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'artifacts'), { recursive: true });
    const tq = `target=${target}`;

    const meta = (await getJson(`/api/meta?${tq}`)).body;
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));

    console.log(`${target}: attack run…`);
    const run = await stream(`/api/run?${RUN_Q}&${tq}`);
    writeFileSync(join(dir, 'run.json'), JSON.stringify(run));

    console.log(`${target}: full loop…`);
    const loop = await stream(`/api/loop?${LOOP_Q}&${tq}`);
    writeFileSync(join(dir, 'loop.json'), JSON.stringify(loop));
    const done = loop.find((e) => e.data?.type === 'run-done');
    const runId = done?.data?.summary?.runId;
    if (!runId) throw new Error(`${target}: loop did not finish: ${JSON.stringify(loop.at(-1))}`);

    // Artifacts the result card links to, plus the badge.
    const runDir = join('.bulwark', 'runs', runId);
    const files = [];
    for (const f of (await import('node:fs')).readdirSync(runDir)) {
      if (/\.(md|patch|json|svg)$/.test(f)) { writeFileSync(join(dir, 'artifacts', f), readFileSync(join(runDir, f))); files.push(f); }
    }
    if (existsSync('.bulwark/badge.svg')) writeFileSync(join(dir, 'badge.svg'), readFileSync('.bulwark/badge.svg'));

    const { replays, diffs } = await recordReplays(dir, meta.target, runId, run, loop);
    index.targets[target] = { runId, artifacts: files, replays, diffs, loopSeconds: Math.round(loop.at(-1).t / 1000) };
    console.log(`${target}: done`, index.targets[target]);
  }

  writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 2));
  stop?.();
}

if (process.argv[2] === '--replays') {
  // Re-capture only the replays and diffs of the recorded runs (the run workspaces must still be in .bulwark/runs).
  const stop = await startServer();
  const index = JSON.parse(readFileSync(join(OUT, 'index.json'), 'utf8'));
  for (const [target, info] of Object.entries(index.targets)) {
    const dir = join(OUT, target), read = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
    Object.assign(info, await recordReplays(dir, read('meta.json').target, info.runId, read('run.json'), read('loop.json')));
  }
  writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 2));
  stop?.();
} else main().catch((err) => { console.error(err); process.exit(1); });
