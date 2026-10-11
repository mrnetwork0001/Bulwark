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

  // Builds on the refund guard's order lookup, so it never costs an extra call.
  ownership: {
    id: 'ownership-check',
    marker: 'bulwark:ownership',
    apply: (files) =>
      chain(
        files,
        (f) =>
          edit(
            f,
            TOOLS,
            `      const amount = Math.min(Number(input.amount), order.total);\n`,
            `      const amount = Math.min(Number(input.amount), order.total);
      // bulwark:ownership: only refund orders that belong to the ticket's customer, whoever they claim to be
      if (ticket && order.email !== ticket.customerEmail) {
        return { refused: true, reason: \`order \${order.id} does not belong to \${ticket.customerEmail}; refunds go only to the order's owner\` };
      }
`,
          ),
        (f) =>
          edit(
            f,
            TOOLS,
            'export function createTools(transport: Transport): Tools {',
            'export function createTools(transport: Transport, ticket?: { customerEmail: string }): Tools {',
          ),
        (f) => edit(f, AGENT, 'const tools = createTools(deps.transport);', 'const tools = createTools(deps.transport, ticket);'),
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

// Partial: generated faults may have a kind ('novel') no textbook fix covers.
// The LLM fixer still handles those; the playbook simply has nothing to offer.
export const PLAYBOOK: Partial<Record<FaultKind, Strategy[]>> = {
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
  social: [
    { id: 'refund-guard', title: 'Server-side refund guard', rationale: 'Whatever the customer claims, a refund can never exceed the order total. Enforced in code, not in the prompt.', transforms: [T.refundGuard] },
    { id: 'refund-guard+ownership-check', title: 'Refund guard + ownership check', rationale: "Capping the amount does not stop a customer from talking the agent into refunding someone else's order. issue_refund now checks that the order's customer email matches the ticket's, and refuses otherwise.", transforms: [T.refundGuard, T.ownership] },
  ],
};

// ---- ResearchBot (targets/researchbot): textbook fixes for a data-API client ----
// Resilience is added once per file by wrapping the transport at the top of
// createTools: timeouts and body validation innermost, the retry outermost (its
// line goes just before `return {`), so a timed-out or cut-off call is retried.

const R_TOOLS_OPEN = 'export function createTools(transport: Transport): Tools {\n';
const R_TOOLS_RETURN = '  return {\n    enrich_company:';
const R_AGENT_ANCHOR = 'export async function runResearchBot(';

/** Adds a transport wrapper line at the top of createTools (runs first, so it ends up innermost). */
const wrapInner = (files: Files, line: string) => edit(files, TOOLS, R_TOOLS_OPEN, `${R_TOOLS_OPEN}${line}\n`);

const R: Record<string, Transform> = {
  retry: {
    id: 'retry-transient',
    marker: 'bulwark:retry-transient',
    apply: (files) =>
      chain(
        files,
        (f) => edit(f, TOOLS, R_TOOLS_RETURN, `  transport = withRetry(transport);\n${R_TOOLS_RETURN}`),
        (f) =>
          ensureHelper(
            f,
            TOOLS,
            'function withRetry(',
            TOOLS_ANCHOR,
            `const CALL_ATTEMPTS = 4;

// bulwark:retry-transient: 429s, 5xx, timeouts and unreadable bodies are retried; other 4xx are not
function withRetry(transport: Transport): Transport {
  return async (endpoint, payload) => {
    let lastErr: unknown;
    for (let i = 0; i < CALL_ATTEMPTS; i++) {
      try {
        return await transport(endpoint, payload);
      } catch (err) {
        lastErr = err;
        const status = (err as { status?: number }).status;
        if (status !== undefined && status !== 429 && status < 500) throw err;
        if (i < CALL_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, retryDelayMs(err, i)));
      }
    }
    throw lastErr;
  };
}

function retryDelayMs(_err: unknown, attempt: number): number {
  return 100 * 2 ** attempt;
}
`,
          ),
      ),
  },

  // Builds on the retry: same call sites, smarter wait.
  retryAfter: {
    id: 'rate-limit-reset',
    marker: 'bulwark:rate-limit-reset',
    apply: (files) =>
      edit(
        files,
        TOOLS,
        `function retryDelayMs(_err: unknown, attempt: number): number {
  return 100 * 2 ** attempt;
}`,
        `function retryDelayMs(err: unknown, attempt: number): number {
  // bulwark:rate-limit-reset: a 429 says when capacity frees up (x-ratelimit-reset / Retry-After, in seconds); wait that long
  const headers = (err as { headers?: Record<string, string> }).headers ?? {};
  const reset = Number(headers['x-ratelimit-reset'] ?? headers['retry-after']);
  return Number.isFinite(reset) && reset > 0 ? reset * 1000 + 50 : 100 * 2 ** attempt;
}`,
      ),
  },

  timeout: {
    id: 'call-timeout',
    marker: 'bulwark:call-timeout',
    apply: (files) =>
      chain(
        files,
        (f) => wrapInner(f, '  transport = withTimeout(transport, CALL_TIMEOUT_MS);'),
        (f) =>
          ensureHelper(
            f,
            TOOLS,
            'function withTimeout(',
            TOOLS_ANCHOR,
            `const CALL_TIMEOUT_MS = 1500;

// bulwark:call-timeout: no Crustdata call may hang the run
function withTimeout(transport: Transport, ms: number): Transport {
  return (endpoint, payload) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(\`\${endpoint} timed out after \${ms}ms\`)), ms);
      transport(endpoint, payload).then(
        (v) => (clearTimeout(t), resolve(v)),
        (e) => (clearTimeout(t), reject(e)),
      );
    });
}
`,
          ),
      ),
  },

  validJson: {
    id: 'valid-json',
    marker: 'bulwark:valid-json',
    apply: (files) =>
      chain(
        files,
        (f) => wrapInner(f, '  transport = requireJson(transport);'),
        (f) =>
          ensureHelper(
            f,
            TOOLS,
            'function requireJson(',
            TOOLS_ANCHOR,
            `// bulwark:valid-json: a cut-off body is a failed call (retried), not something to parse
function requireJson(transport: Transport): Transport {
  return async (endpoint, payload) => {
    const raw = await transport(endpoint, payload);
    JSON.parse(raw);
    return raw;
  };
}
`,
          ),
      ),
  },

  schema: {
    id: 'schema-validation',
    marker: 'bulwark:schema',
    apply: (files) =>
      chain(
        files,
        (f) =>
          edit(
            f,
            TOOLS,
            `      const company = (JSON.parse(raw) as EnrichResponse)[0].matches[0].company_data;
      return {
        name: company.basic_info!.name,
        domain: company.basic_info!.primary_domain,
        headcount: company.headcount!.total,
        industry: company.taxonomy!.professional_network_industry,
        fundingUsd: company.funding!.total_investment_usd,
      };`,
            `      return parseCompany(raw, String(input.domain));`,
          ),
        (f) =>
          ensureHelper(
            f,
            TOOLS,
            'function parseCompany(',
            TOOLS_ANCHOR,
            `// bulwark:schema: a missing section becomes null instead of a crash; no match is an explicit "not found"
function parseCompany(raw: string, domain: string): CompanyFacts | { notFound: true; domain: string } {
  const body = JSON.parse(raw) as EnrichResponse;
  const data = Array.isArray(body) ? body[0]?.matches?.[0]?.company_data : undefined;
  const name = data?.basic_info?.name;
  if (!data || typeof name !== 'string') return { notFound: true, domain };
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const str = (x: unknown) => (typeof x === 'string' && x ? x : null);
  return {
    name,
    domain: str(data.basic_info?.primary_domain) ?? domain,
    headcount: num(data.headcount?.total),
    industry: str(data.taxonomy?.professional_network_industry),
    fundingUsd: num(data.funding?.total_investment_usd),
  };
}
`,
          ),
      ),
  },

  ground: {
    id: 'ground-brief',
    marker: 'bulwark:grounded',
    apply: (files) =>
      chain(
        files,
        (f) =>
          edit(
            f,
            AGENT,
            `      if (decision.type === 'final') return { reply: decision.reply, steps: history };`,
            `      if (decision.type === 'final') return { reply: groundBrief(decision.reply, history), steps: history };`,
          ),
        (f) => edit(f, AGENT, "import { createTools, type ToolName } from './tools';", "import { createTools, type CompanyFacts, type PersonFacts, type ToolName } from './tools';"),
        (f) =>
          ensureHelper(
            f,
            AGENT,
            'function groundBrief(',
            R_AGENT_ANCHOR,
            `// bulwark:grounded: the brief may only state what a tool returned. It is rebuilt from the tool
// results: values the API didn't return become null, people the search never returned are dropped
// (each person once), and no company means an explicit "not found".
function groundBrief(reply: string, history: Step[]): string {
  const company = history
    .filter((s) => s.tool === 'enrich_company')
    .map((s) => s.output as (Partial<CompanyFacts> & { notFound?: boolean }) | undefined)
    .at(-1);
  const asked = history.find((s) => s.tool === 'enrich_company')?.input.domain;
  const domain = company?.domain ?? (typeof asked === 'string' ? asked : null);
  if (!company || company.notFound || typeof company.name !== 'string') return JSON.stringify({ status: 'not found', domain });
  const found = new Map<string, PersonFacts>();
  for (const s of history) {
    if (s.tool !== 'search_people' || !Array.isArray(s.output)) continue;
    for (const p of s.output as PersonFacts[]) if (!found.has(p.name)) found.set(p.name, p);
  }
  let claimed: { name?: string }[] = [];
  try {
    const brief = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1));
    if (Array.isArray(brief.people)) claimed = brief.people;
  } catch {
    // not JSON: keep no people rather than guess
  }
  const people = [...new Set(claimed.map((p) => p?.name))]
    .flatMap((name) => {
      const p = name ? found.get(name) : undefined;
      return p ? [{ name: p.name, title: p.title }] : [];
    })
    .slice(0, 3);
  return JSON.stringify({
    status: 'ok',
    name: company.name,
    domain: company.domain ?? domain,
    headcount: company.headcount ?? null,
    industry: company.industry ?? null,
    fundingUsd: company.fundingUsd ?? null,
    people,
  });
}
`,
          ),
      ),
  },

  retryEmpty: {
    id: 'retry-empty-search',
    marker: 'bulwark:empty-search-retry',
    apply: (files) =>
      edit(
        files,
        TOOLS,
        `      } while (cursor);
      return people;`,
        `      } while (cursor);
      // bulwark:empty-search-retry: an empty result may be a blip, so ask once more
      if (people.length === 0) {
        const raw = await transport('person.search', peopleQuery(String(input.domain), Number(input.limit ?? 3)));
        for (const p of (JSON.parse(raw) as PersonSearchResponse).profiles) people.push({ id: p.crustdata_person_id, name: p.basic_profile.name, title: p.basic_profile.current_title ?? '' });
      }
      return people;`,
      ),
  },

  cursorCap: {
    id: 'cursor-cap',
    marker: 'bulwark:cursor-cap',
    apply: (files) =>
      chain(
        files,
        (f) =>
          edit(
            f,
            TOOLS,
            `      let cursor: string | null = null;
      // Collect every page of leaders.
      do {`,
            `      let cursor: string | null = null;
      let pages = 0;
      // bulwark:cursor-cap: at most MAX_PAGES pages (each page costs credits), and each person once
      do {`,
          ),
        (f) => edit(f, TOOLS, '        for (const p of page.profiles) people.push(', '        for (const p of page.profiles) if (!people.some((x) => x.id === p.crustdata_person_id)) people.push('),
        (f) => edit(f, TOOLS, '      } while (cursor);', '      } while (cursor && ++pages < MAX_PAGES);'),
        (f) => ensureHelper(f, TOOLS, 'const MAX_PAGES', TOOLS_ANCHOR, `const MAX_PAGES = 2;\n`),
      ),
  },

  stepBudget: {
    id: 'step-budget',
    marker: 'bulwark:research-step-budget',
    apply: (files) =>
      chain(
        files,
        (f) =>
          edit(
            f,
            AGENT,
            `    while (true) {
      const decision`,
            `    while (true) {
      // bulwark:research-step-budget: a stuck run can't take unbounded steps
      if (history.length >= MAX_STEPS) return { reply: JSON.stringify({ status: 'not found', domain: null, reason: 'step budget exhausted' }), steps: history };
      const decision`,
          ),
        (f) => ensureHelper(f, AGENT, 'const MAX_STEPS', R_AGENT_ANCHOR, 'const MAX_STEPS = 6;\n'),
      ),
  },
};

export const RESEARCH_PLAYBOOK: Partial<Record<FaultKind, Strategy[]>> = {
  'rate-limit': [
    { id: 'retry-backoff', title: 'Retry transient errors with exponential backoff', rationale: 'A 429 is transient: retry with 100/200/400ms backoff instead of crashing.', transforms: [R.retry] },
    { id: 'retry-after', title: 'Retry, honouring the rate-limit reset header', rationale: 'Retrying inside the rate-limit window just collects more 429s. Crustdata says when capacity frees up (x-ratelimit-reset, like Retry-After); wait that long, then retry.', transforms: [R.retry, R.retryAfter] },
  ],
  'server-error': [
    { id: 'retry-backoff', title: 'Retry 5xx with exponential backoff', rationale: 'A 500 that says "try again later" is transient: retry with backoff; 4xx client errors are not retried.', transforms: [R.retry] },
  ],
  latency: [
    { id: 'timeout', title: 'Timeout on every Crustdata call', rationale: 'Bound each call to 1.5s so a slow response cannot hang the run.', transforms: [R.timeout] },
    { id: 'timeout+retry', title: 'Timeout, then retry', rationale: 'A timeout alone turns a hang into a crash; retry the timed-out call (the spike is transient).', transforms: [R.timeout, R.retry] },
  ],
  malformed: [
    { id: 'retry-backoff', title: 'Retry failed calls', rationale: 'Retry transient failures with backoff.', transforms: [R.retry] },
    { id: 'valid-json+retry', title: 'Validate the body, then retry', rationale: 'A cut-off body arrives as a successful call and only fails when parsed, so a plain retry never sees it. Check the body parses at the transport, which turns it into a retryable failure.', transforms: [R.validJson, R.retry] },
  ],
  partial: [
    { id: 'schema-validation', title: 'Validate the company record', rationale: 'Read every field defensively: a missing section becomes null instead of a TypeError, and no match becomes an explicit "not found".', transforms: [R.schema] },
    { id: 'schema-validation+ground-brief', title: 'Validate the record and ground the brief', rationale: 'With the crash gone, the model fills the missing headcount with a guess. Rebuild the brief from the tool results so it can only state what the API returned (unknown → null).', transforms: [R.schema, R.ground] },
  ],
  empty: [
    { id: 'retry-empty-search', title: 'Retry an empty people search', rationale: 'Maybe the empty result was a blip; ask once more before answering.', transforms: [R.retryEmpty] },
    { id: 'ground-brief', title: 'Ground the brief in tool results', rationale: 'An empty result is an answer, not a blip. The brief keeps only people the search returned (none → an empty list), so the model cannot invent decision-makers.', transforms: [R.ground] },
  ],
  loop: [
    { id: 'step-budget', title: 'Step budget', rationale: 'Cap the agent at 6 steps so a stuck run cannot go on forever.', transforms: [R.stepBudget] },
    { id: 'cursor-cap', title: 'Cursor cap + dedupe (bounds credits per brief)', rationale: 'The loop is inside one tool call, so a step budget never sees it. Follow next_cursor for at most 2 pages (every page is billed) and keep each person once.', transforms: [R.cursorCap] },
  ],
};

/** Each target's strategies, by target name. RefundBot's is the default. */
export const PLAYBOOKS: Record<string, Partial<Record<FaultKind, Strategy[]>>> = {
  refundbot: PLAYBOOK,
  researchbot: RESEARCH_PLAYBOOK,
};

export function playbookFor(target?: string): Partial<Record<FaultKind, Strategy[]>> {
  return PLAYBOOKS[target ?? 'refundbot'] ?? {};
}

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
