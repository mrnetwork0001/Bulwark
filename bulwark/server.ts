// Local site: npm run dashboard → http://localhost:5317 (landing page), /app (dashboard)
// Streams chaos experiments to the browser as trials finish (Server-Sent Events).

import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { target } from '../targets/refundbot/bulwark.target';
import { FAULTS, getFault, type Fault } from './chaos/faults';
import { runExperiment } from './scorecard';
import { initTracing } from './tracing';

const PORT = Number(process.env.PORT ?? 5317);
const PAGES: Record<string, URL> = {
  '/': new URL('./dashboard/landing.html', import.meta.url),
  '/app': new URL('./dashboard/index.html', import.meta.url),
};

function send(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function streamRun(res: ServerResponse, params: URLSearchParams) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const faultParam = params.get('fault') ?? 'all';
  const faults: (Fault | undefined)[] = faultParam === 'all' ? [undefined, ...FAULTS] : [undefined, getFault(faultParam)];
  const opts = {
    trials: Math.min(200, Math.max(1, Number(params.get('trials') ?? 20))),
    seed: Number(params.get('seed') ?? 42),
    brain: 'simulated' as const,
    deadlineMs: 5000,
    maxSteps: 50,
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
            refunds: obs.refunds.map((r) => r.amount),
            error: obs.error,
          }),
      });
      send(res, 'experiment-done', result);
    }),
  );
  send(res, 'done', {});
  res.end();
}

async function main() {
  const exporting = await initTracing('bulwark-dashboard');

  createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    if (url.pathname in PAGES) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(PAGES[url.pathname]));
    } else if (url.pathname === '/api/meta') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          target: target.name,
          rules: target.rules,
          neatlogs: exporting,
          faults: [
            { id: 'baseline', title: 'No fault injected', hypothesis: 'The agent works when nothing breaks.' },
            ...FAULTS.map(({ id, title, hypothesis }) => ({ id, title, hypothesis })),
          ],
        }),
      );
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
