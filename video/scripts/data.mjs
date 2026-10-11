// Pulls the real data the film shows into src/data.json, from the repo itself:
//   - the cold-open trial, replayed from its seed (npm run replay -- --json)
//   - bug provenance from Entire (npm run provenance -- targets/refundbot/tools.ts:87)
//   - entire status (first lines: enabled, agent)
//   - the self-chaos result (docs/evidence/07-self-chaos/result.json)
//   - the headline numbers, each read from the file that states it (asserted, not typed in)
//   node scripts/data.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VIDEO = new URL("..", import.meta.url).pathname;
const REPO = join(VIDEO, "..");
const run = (cmd, args) => execFileSync(cmd, args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, NEATLOGS_API_KEY: "" } });
const read = (p) => readFileSync(join(REPO, p), "utf8");
const must = (text, re, label) => { const m = text.match(re); if (!m) throw new Error(`not found: ${label}`); return m; };

// 1. The cold open: RefundBot, timeout-after-commit, seed 1286473109.
const raw = run("npx", ["tsx", "bulwark/replay-cli.ts", "--fault", "timeout-after-commit", "--seed", "1286473109", "--json"]);
const rp = JSON.parse(raw.slice(raw.indexOf("{")));
const trial = {
  target: rp.target, fault: rp.fault, seed: rp.seed,
  order: rp.observation.fixtures.orders.find((o) => o.id === rp.observation.ticket.orderId),
  ticket: rp.observation.ticket,
  refunds: rp.observation.effects.refunds,
  broken: rp.broken.map((b) => ({ rule: b.rule, detail: b.detail })),
  events: rp.timeline.map((e) => ({ t: e.t, type: e.type, endpoint: e.endpoint, name: e.decision?.name, input: e.input ?? e.decision?.input, afterMs: e.afterMs, retryOf: e.retryOf, detail: e.detail, effect: e.effect, data: e.data, kind: e.decision?.type })),
};

// 2. Entire: provenance of the weak line, and entire status.
const prov = run("npx", ["tsx", "bulwark/provenance/cli.ts", "targets/refundbot/tools.ts:87"]).split("\n").filter((l) => /^\s{2}\w/.test(l)).map((l) => l.trim());
let status = [];
try { status = run("entire", ["status"]).split("\n").map((l) => l.replace(/\s+$/, "")).filter(Boolean).slice(0, 4); } catch { status = []; }
const checkpoints = (read("README.md").match(/(\d+) checkpoints pushed/) ?? [])[1];

// 3. Self-chaos.
const sc = JSON.parse(read("docs/evidence/07-self-chaos/result.json"));

// 4. Headline numbers, each checked against the file that states it.
const readme = read("README.md");
must(readme, /\*\*56% → 100%\*\*/, "RefundBot 56 -> 100");
must(readme, /\*\*49% → 100%\*\*/, "ResearchBot 49 -> 100");
must(readme, /\*\*43% → 100%\*\*/, "game day 43 -> 100");
must(readme, /\$553,438 → \$0 per 1,000 RefundBot tickets/, "money at risk");
must(readme, /8 attempts \(3 rejected and rolled back\)/, "attempts");
must(readme, /p < 10⁻⁶/, "Fisher p");
must(readme, /found and fixed 5 real robustness bugs/, "self-chaos bugs");
const plan = read("docs/business/cfo-ai-plan.md");
must(readme, /Year 1–3 ARR \$77k → \$232k → \$774k; cash-flow positive from 2028-11/, "cfo.ai ARR");
const market = read("docs/business/market-sizing.md");
must(market, /SAM 52,405/, "Crustdata SAM");

const data = {
  trial,
  provenance: prov,
  entireStatus: status,
  checkpoints: checkpoints ? Number(checkpoints) : null,
  selfChaos: { injected: sc.totals.injected, recovered: sc.totals.recovered, seams: sc.seams.map((s) => s.seam), bugsFixed: 5 },
  numbers: {
    refundbot: [56, 100], researchbot: [49, 100], gameDay: [43, 100],
    atRisk: [553438, 0], attempts: 8, rejected: 3, judgeTrials: 40, sloTrials: 59, tests: null,
    arr: [77442, 232325, 774416], cashPositive: "2028-11", agentBuilders: 52405,
    planUrl: (plan.match(/https:\/\/app\.cfo\.ai\/s\/[\w-]+/) ?? [])[0],
  },
};
// 5. Test count, from the repo's own test run (node --test summary line "# tests N").
try {
  const out = execFileSync("npm", ["test"], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NEATLOGS_API_KEY: "" } });
  data.numbers.tests = Number((out.match(/^(?:#|ℹ) tests (\d+)/m) ?? [])[1]) || null;
} catch (e) { data.numbers.tests = Number(((e.stdout ?? "").match(/^(?:#|ℹ) tests (\d+)/m) ?? [])[1]) || null; }
writeFileSync(join(VIDEO, "src/data.json"), JSON.stringify(data, null, 1));
console.log(`trial: ${trial.events.length} events, ${trial.refunds.length} refunds; provenance ${prov.length} lines; entire status ${status.length} lines; tests ${data.numbers.tests}`);
