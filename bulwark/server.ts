// Local site: npm run dashboard → http://localhost:5317 (landing page), /app (dashboard)
// Streams chaos experiments to the browser as trials finish (Server-Sent Events).

import './env';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { relative } from 'node:path';
import { faultsFor, getFault, type Fault } from './chaos/faults';
import { parseSlo } from './judge/slo';
import { parseTournament } from './judge/tournament';
import { runLoop } from './loop/orchestrator';
import { diffFromParams } from './diff';
import { replayFromParams } from './replay';
import { runExperiment } from './scorecard';
import { defaultModel, llmLabel, llmProvider } from './llm';
import { listTargets, loadTarget, resolveTargetDir, type BulwarkTarget } from './target';
import { initTracing } from './tracing';

const PORT = Number(process.env.PORT ?? 5317);
const PAGES: Record<string, URL> = {
  '/': new URL('./dashboard/landing.html', import.meta.url),
  '/app': new URL('./dashboard/index.html', import.meta.url),
};

function send(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ?target=researchbot (default refundbot): only directories under targets/ with a bulwark.target.ts.
const loaded = new Map<string, Promise<BulwarkTarget>>();
function targetFrom(params: URLSearchParams): Promise<BulwarkTarget> {
  let dir: string;
  try {
    dir = resolveTargetDir(params.get('target'));
  } catch (err) {
    return Promise.reject(err);
  }
  if (!loaded.has(dir)) loaded.set(dir, loadTarget(dir));
  return loaded.get(dir)!;
}

async function streamRun(res: ServerResponse, params: URLSearchParams) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const faultParam = params.get('fault') ?? 'all';
  const target = await targetFrom(params);
  const faults: (Fault | undefined)[] = faultParam === 'all' ? [undefined, ...faultsFor(target)] : [undefined, getFault(faultParam, target)];
  const opts = {
    trials: Math.min(200, Math.max(1, Number(params.get('trials') ?? 20))),
    seed: Number(params.get('seed') ?? 42),
    brain: 'simulated' as const,
    deadlineMs: 5000,
    maxSteps: 50,
    sessionId: `chaos-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  };

  // Experiments run concurrently so the whole board fills in at once.
  await Promise.all(
    faults.map(async (fault) => {
      const id = fault?.id ?? 'baseline';
      send(res, 'experiment-start', { fault: id, trials: opts.trials });
      const result = await runExperiment(target, fault, {
        ...opts,
        onTrial: ({ index, obs, broken }) =>
          send(res, 'trial', {
            fault: id,
            index,
            outcome: obs.outcome,
            passed: broken.length === 0,
            broken,
            seed: obs.seed,
            durationMs: Math.round(obs.durationMs),
            steps: obs.steps,
            refunds: (obs.refunds ?? []).map((r) => r.amount),
            error: obs.error,
          }),
      });
      send(res, 'experiment-done', result);
    }),
  );
  send(res, 'done', {});
  res.end();
}

let loopRunning = false;

async function streamLoop(res: ServerResponse, params: URLSearchParams) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  if (loopRunning) {
    send(res, 'loop-error', { message: 'A Bulwark loop is already running. Wait for it to finish.' });
    return res.end();
  }
  loopRunning = true;
  try {
    // Optional: a reliability target (e.g. slo=0.95) and a fix tournament (e.g. tournament=playbook,playbook-strong).
    const slo = params.get('slo') ? parseSlo(params.get('slo')!) : undefined;
    const tournament = params.get('tournament') ? parseTournament(params.get('tournament')!) : undefined;
    await runLoop(
      {
        targetDir: relative(process.cwd(), resolveTargetDir(params.get('target'))),
        // neatlogs read-back wait per fault: short by default so the live demo stays snappy (wait=0 to skip).
        readbackWaitMs: Math.min(60_000, Math.max(0, Number(params.get('wait') ?? process.env.BULWARK_NEATLOGS_WAIT_MS ?? 5000))),
        ...(slo ? { slo } : {}),
        ...(tournament ? { tournament } : {}),
        memory: params.get('memory') === '1',
        redTrials: Math.min(100, Math.max(5, Number(params.get('trials') ?? 20))),
        seed: Number(params.get('seed') ?? 42),
      },
      (e) => send(res, 'loop', e.type === 'run-done' ? { ...e, summary: { ...e.summary, finalFiles: undefined } } : e),
    );
  } catch (err) {
    send(res, 'loop-error', { message: err instanceof Error ? err.message : String(err) });
  } finally {
    loopRunning = false;
    res.end();
  }
}

const ARTIFACT_TYPES: Record<string, string> = {
  md: 'text/markdown; charset=utf-8',
  patch: 'text/plain; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
};

function serveArtifact(res: ServerResponse, params: URLSearchParams) {
  const run = params.get('run') ?? '';
  const file = params.get('file') ?? '';
  const ext = file.split('.').pop() ?? '';
  const path = join('.bulwark', 'runs', run, file);
  if (!/^[\w-]+$/.test(run) || !/^[\w.-]+$/.test(file) || !(ext in ARTIFACT_TYPES) || !existsSync(path)) {
    return res.writeHead(404).end('not found');
  }
  res.writeHead(200, { 'content-type': ARTIFACT_TYPES[ext] });
  res.end(readFileSync(path));
}

async function main() {
  const exporting = await initTracing('bulwark-dashboard');

  createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    if (url.pathname in PAGES) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(PAGES[url.pathname]));
    } else if (url.pathname === '/api/meta') {
      targetFrom(url.searchParams).then(
        (target) =>
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              target: target.name,
              targets: listTargets(),
              rules: target.rules,
              // Dollars at risk is only shown for targets with a risk model.
              risk: !!target.risk,
              neatlogs: exporting,
              fixer: llmProvider() ? `${defaultModel('fixer')} via ${llmLabel()} + playbook` : 'playbook (add an LLM key for Claude)',
              faults: [
                { id: 'baseline', title: 'No fault injected', hypothesis: 'The agent works when nothing breaks.' },
                ...faultsFor(target).map(({ id, title, hypothesis }) => ({ id, title, hypothesis })),
              ],
            }),
          ),
        (err) => res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) })),
      );
    } else if (url.pathname === '/api/loop') {
      streamLoop(res, url.searchParams);
    } else if (url.pathname === '/api/replay') {
      replayFromParams(url.searchParams).then(
        (r) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r)),
        (err) => res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) })),
      );
    } else if (url.pathname === '/api/diff') {
      // One seed before vs after the run's accepted fix for that fault, aligned, divergence marked.
      diffFromParams(url.searchParams).then(
        (r) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r)),
        (err) => res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) })),
      );
    } else if (url.pathname === '/api/artifact') {
      serveArtifact(res, url.searchParams);
    } else if (url.pathname === '/theme.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(readFileSync(new URL('./dashboard/theme.css', import.meta.url)));
    } else if (url.pathname === '/badge.svg') {
      if (!existsSync('.bulwark/badge.svg')) return res.writeHead(404).end('no badge yet');
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-cache' });
      res.end(readFileSync('.bulwark/badge.svg'));
    } else if (url.pathname === '/api/run') {
      streamRun(res, url.searchParams).catch((err) => {
        send(res, 'error', { message: err instanceof Error ? err.message : String(err) });
        res.end();
      });
    } else {
      res.writeHead(404).end('not found');
    }
  }).listen(PORT, () => {
    console.log(`Bulwark dashboard → http://localhost:${PORT}  (neatlogs ${exporting ? 'exporting' : 'local only'})`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
