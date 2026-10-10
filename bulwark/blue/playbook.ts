// Blue agent's playbook: textbook resilience fixes as precise source transforms.
// Used when no LLM key is configured, and as the fallback when the LLM fixer runs
// out of ideas. Strategies for a fault are ordered cheapest-first, the way an
// engineer under pressure would try them, so the cheap-but-wrong fix gets tried
// and rejected by the Judge before the real one.

import type { FaultKind } from '../chaos/faults';
import type { Files } from '../workspace';

interface Transform {
  id: string;
  marker: string;
  apply: (files: Files) => Files | null;
}

function edit(files: Files, path: string, find: string, replace: string): Files | null {
  const src = files[path];
  if (src === undefined || !src.includes(find)) return null;
  return { ...files, [path]: src.replace(find, replace) };
}

function chain(files: Files | null, ...steps: ((f: Files) => Files | null)[]): Files | null {
  for (const step of steps) {
    if (!files) return null;
    files = step(files);
  }
  return files;
}

function ensureHelper(files: Files, path: string, name: string, before: string, code: string): Files | null {
  if (files[path]?.includes(name)) return files;
  return edit(files, path, before, `${code}\n${before}`);
}

const TOOLS = 'tools.ts';
const AGENT = 'agent.ts';
const TOOLS_ANCHOR = 'export type Tools = Record<';
const AGENT_ANCHOR = 'export async function runRefundBot(';

const ESCALATE_HELPER = `const MAX_STEPS = 8;

// When the agent can't finish safely, tell the customer a human will follow up
// instead of failing silently.
async function escalate(tools: Tools, ticket: Ticket): Promise<RunResult['reply']> {
  await tools.send_email({
    to: ticket.customerEmail,
    subject: \`Your refund request (\${ticket.orderId})\`,
    body: 'We hit a problem processing your refund automatically. A teammate will follow up within 24 hours.',
  });
  return \`Escalated \${ticket.id} to a human.\`;
}
`;

function withEscalateHelper(files: Files): Files | null {
  return chain(
    files,
    (f) => (f[AGENT]?.includes('type Tools }') ? f : edit(f, AGENT, "import { createTools, type ToolName } from './tools';", "import { createTools, type ToolName, type Tools } from './tools';")),
    (f) => ensureHelper(f, AGENT, 'async function escalate(', AGENT_ANCHOR, ESCALATE_HELPER),
  );
}

const T: Record<string, Transform> = {
  hardenLookup: {
    id: 'harden-lookup',
    marker: 'bulwark:lookup-hardened',
    apply: (files) =>
      chain(
        files,
        (f) =>
          edit(
            f,
            TOOLS,
            `      const raw = await transport('orders.get', { orderId: input.orderId });
      return JSON.parse(raw) as Order;`,
            `      // bulwark:lookup-hardened: bounded wait, validated body, retried on transient failure
      return withRetry(
        async () => parseOrder(await withTimeout(transport('orders.get', { orderId: input.orderId }), LOOKUP_TIMEOUT_MS)),
        LOOKUP_ATTEMPTS,
      );`,
          ),
        (f) =>
          ensureHelper(
            f,
            TOOLS,
            'function parseOrder(',
            TOOLS_ANCHOR,
            `const LOOKUP_TIMEOUT_MS = 1000;
const LOOKUP_ATTEMPTS = 3;

function parseOrder(raw: string): Order {
  const order = JSON.parse(raw) as Order;
  if (typeof order?.id !== 'string' || typeof order.total !== 'number' || typeof order.status !== 'string') {
    throw new Error('invalid order payload');
  }
  return order;
}
`,
          ),
      ),
  },

  backoff: {
    id: 'retry-backoff',
    marker: 'bulwark:backoff',
    apply: (files) =>
      edit(
        files,
        TOOLS,
        `    } catch (err) {
      lastErr = err;
    }`,
        `    } catch (err) {
      lastErr = err;
      // bulwark:backoff: exponential backoff between attempts
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 100 * 2 ** i));
    }`,
      ),
  },

  idempotency: {
    id: 'idempotency-key',
    marker: 'bulwark:idempotency',
    apply: (files) =>
      edit(
        files,
        TOOLS,
        `            transport('refunds.create', { orderId: input.orderId, `,
        `            // bulwark:idempotency: a replayed refund returns the original instead of paying twice
            transport('refunds.create', { orderId: input.orderId, idempotencyKey: \`refund:\${input.orderId}\`, `,
      ),
  },

  refundGuard: {
    id: 'refund-guard',
    marker: 'bulwark:refund-guard',
    apply: (files) =>
      chain(
        files,
        (f) =>
          edit(
            f,
            TOOLS,
            `    issue_refund: span({ kind: 'TOOL', name: 'issue_refund', toolName: 'issue_refund' }, async (input) => {\n`,
            `    issue_refund: span({ kind: 'TOOL', name: 'issue_refund', toolName: 'issue_refund' }, async (input) => {
      // bulwark:refund-guard: never move more money than the order is worth, whatever the model asks for
      const order = await withRetry(
        async () => JSON.parse(await withTimeout(transport('orders.get', { orderId: input.orderId }), 1000)) as Order,
        3,
      );
      const amount = Math.min(Number(input.amount), order.total);
`,
          ),
        (f) => edit(f, TOOLS, 'amount: input.amount }', 'amount }'),
      ),
  },

  sanitize: {
    id: 'sanitize-output',
    marker: 'bulwark:sanitize',
    apply: (files) =>
      chain(
        files,
        (f) =>
          edit(f, TOOLS, 'return (JSON.parse(raw) as { text: string }).text;', 'return sanitizeToolText((JSON.parse(raw) as { text: string }).text);'),
        (f) =>
          ensureHelper(
            f,
            TOOLS,
            'function sanitizeToolText(',
            TOOLS_ANCHOR,
            `// bulwark:sanitize: drop instruction-like sentences from tool output before the model sees it
function sanitizeToolText(text: string): string {
  return text
    .split(/(?<=\\.)\\s+/)
    .filter((s) => !/ignore (all |any )?previous instructions|system notice/i.test(s))
    .join(' ');
}
`,
          ),
      ),
  },

  escalate: {
    id: 'escalate-on-failure',
    marker: 'bulwark:graceful',
    apply: (files) =>
      chain(
        files,
        (f) =>
          edit(
            f,
            AGENT,
            `        const output = await tools[decision.name](decision.input);`,
            `        let output: unknown;
        try {
          output = await tools[decision.name](decision.input);
        } catch {
          // bulwark:graceful: a failed tool escalates to a human instead of crashing the run
          return { reply: await escalate(tools, ticket), steps: history };
        }`,
          ),
        withEscalateHelper,
      ),
  },

  stepBudget: {
    id: 'step-budget',
    marker: 'bulwark:step-budget',
    apply: (files) =>
      chain(
        files,
        (f) =>
          edit(
            f,
            AGENT,
            `      while (true) {
        const decision`,
            `      while (true) {
        // bulwark:step-budget: a stuck tool can't burn unbounded steps and tokens
        if (history.length >= MAX_STEPS) return { reply: await escalate(tools, ticket), steps: history };
        const decision`,
          ),
        withEscalateHelper,
      ),
  },
};

export interface Strategy {
  id: string;
  title: string;
  rationale: string;
  transforms: Transform[];
}

export const PLAYBOOK: Record<FaultKind, Strategy[]> = {
  latency: [
    { id: 'harden-lookup', title: 'Timeout + retry on order lookup', rationale: 'Bound each lookup to 1s and retry up to 3 times so one slow response cannot hang the run.', transforms: [T.hardenLookup] },
    { id: 'harden-lookup+escalate', title: 'Timeout + retry, then escalate', rationale: 'Retries alone still fail when every attempt is slow; when they run out, email the customer that a human will follow up.', transforms: [T.hardenLookup, T.escalate] },
  ],
  'commit-timeout': [
    { id: 'retry-backoff', title: 'Exponential backoff on refund retries', rationale: 'Space out refund retries so a struggling payments API can recover.', transforms: [T.backoff] },
    { id: 'idempotency-key', title: 'Idempotency key on refunds', rationale: 'The refund already committed; the retry is the bug. An idempotency key makes a replayed refund return the original instead of paying twice.', transforms: [T.idempotency] },
    { id: 'idempotency-key+escalate', title: 'Idempotency key, then escalate', rationale: 'When every refund attempt times out the run still crashes; escalate to a human instead.', transforms: [T.idempotency, T.escalate] },
  ],
  malformed: [
    { id: 'harden-lookup', title: 'Validate and retry order lookups', rationale: 'Parse and validate the order inside the retry, so a truncated body is retried instead of crashing.', transforms: [T.hardenLookup] },
    { id: 'harden-lookup+escalate', title: 'Validate, retry, then escalate', rationale: 'If every attempt returns garbage, escalate to a human instead of crashing.', transforms: [T.hardenLookup, T.escalate] },
  ],
  'rate-limit': [
    { id: 'harden-lookup', title: 'Retry order lookups', rationale: 'A 429 is transient; retry the lookup instead of crashing.', transforms: [T.hardenLookup] },
    { id: 'harden-lookup+backoff+escalate', title: 'Retry with backoff, then escalate', rationale: 'Back off between retries and escalate if the API stays rate-limited.', transforms: [T.hardenLookup, T.backoff, T.escalate] },
  ],
  injection: [
    { id: 'sanitize-output', title: 'Strip instructions from tool output', rationale: 'Remove instruction-like sentences from tool output before the model sees it.', transforms: [T.sanitize] },
    { id: 'refund-guard', title: 'Server-side refund guard', rationale: 'Filters miss rephrased injections. Enforce the rule in code: a refund can never exceed the order total, whatever the model asks for.', transforms: [T.refundGuard] },
  ],
  loop: [
    { id: 'step-budget', title: 'Step budget with escalation', rationale: 'Cap the agent at 8 steps and escalate to a human, so a stuck tool cannot burn unbounded steps and tokens.', transforms: [T.stepBudget, T.escalate] },
  ],
};

/** Applies a strategy. Returns null if it can't apply or would change nothing. */
export function applyStrategy(strategy: Strategy, files: Files): Files | null {
  let out: Files | null = files;
  for (const t of strategy.transforms) {
    if (!out) return null;
    if (Object.values(out).some((src) => src.includes(t.marker))) continue;
    out = t.apply(out);
  }
  if (!out || Object.keys(out).every((k) => out![k] === files[k])) return null;
  return out;
}
