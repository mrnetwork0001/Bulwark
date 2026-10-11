// Records the real Bulwark dashboard for the demo film.
//   node scripts/capture.mjs                 (needs `PORT=5410 npm run dashboard` from the repo root)
//   ONLY=hero,loop node scripts/capture.mjs  re-records just those clips (marks/meta are merged)
// Clips:
//   hero     landing page hero: the resilience dial animates 56% -> 100%
//   loop     /app: Attack -> Fix -> Prove (memory OFF, SLO 95%), the timeline filling live,
//            the rejected fix and rollback, FIXED + SLO, GUARD, then the Result card
//   replay   the timeout-after-commit trial (seed 1286473109) replayed, then "Compare with fix"
//   target   the target switch to researchbot
//   cfo      the public cfo.ai plan (read-only share link)
// Output: .cache/frames/<clip>/ (JPEG screencast + frames.json), .cache/marks.json,
// .cache/meta.json (rects in CSS px) and stills in public/stills/. 1600x900 CSS px at scale 2.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launch, sleep } from "./cdp.mjs";

const BASE = process.env.BASE || "http://localhost:5410";
if (/:5317\b/.test(BASE)) throw new Error("refusing to record the user's server on :5317");
const CFO = "https://app.cfo.ai/s/xAu-NTAidKxJcCm7";
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const FRAMES = join(ROOT, ".cache/frames");
const STILLS = join(ROOT, "public/stills");
const SCALE = 2;
const VIEW = { w: 1600, h: 900 };
const ONLY = process.env.ONLY?.split(",");
const want = (clip) => !ONLY || ONLY.includes(clip);
mkdirSync(FRAMES, { recursive: true });
mkdirSync(STILLS, { recursive: true });

const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(0)}s`, ...a);
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {});
const marks = readJson(join(ROOT, ".cache/marks.json"));
const meta = readJson(join(ROOT, ".cache/meta.json"));
// Marks and recordings are skipped for clips not being re-recorded (a replay re-take still runs the loop).
const mark = (k) => { if (!want(k.split(/[:_]/)[0])) return; marks[k] = Date.now() / 1000; log("mark", k); };

// A visible pointer (headless Chrome draws none), a click ring and an eased scroll helper.
const OVERLAY = `(() => {
  window.__ease = (el, prop, to, ms) => new Promise((done) => {
    const from = el[prop]; const start = performance.now();
    const f = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = (now) => { const p = Math.min(1, (now - start) / ms); el[prop] = from + (to - from) * f(p); if (p < 1) requestAnimationFrame(step); else done(el[prop]); };
    requestAnimationFrame(step);
  });
  if (document.getElementById('__cur')) return;
  const s = document.createElement('style');
  s.textContent = 'html{scroll-behavior:auto!important}#__cur{position:fixed;left:-40px;top:-40px;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(255,255,255,.97);box-shadow:0 0 0 2px rgba(10,10,10,.7),0 4px 14px rgba(0,0,0,.3);z-index:2147483647;pointer-events:none;opacity:0;transition:opacity .3s ease,transform .12s ease-out,left .8s cubic-bezier(.22,1,.36,1),top .8s cubic-bezier(.22,1,.36,1)}#__cur.down{transform:scale(.7)}.__ring{position:fixed;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;border:2px solid rgba(10,10,10,.55);z-index:2147483646;pointer-events:none;animation:__r .6s ease-out forwards}@keyframes __r{from{transform:scale(.3);opacity:1}to{transform:scale(1.5);opacity:0}}';
  document.head.appendChild(s);
  const c = document.createElement('div'); c.id = '__cur'; document.body.appendChild(c);
})()`;

const b = await launch({ width: VIEW.w, height: VIEW.h, scale: SCALE, extraArgs: [`--force-device-scale-factor=${SCALE}`] });
const hardStop = setTimeout(() => { log("HARD TIMEOUT"); b.close(); process.exit(2); }, 900_000);
const js = (e) => b.js(e);
const overlay = () => js(OVERLAY);

async function glide(x, y, settle = 900) {
  await js(`(() => { const k = document.getElementById('__cur'); if (k) { k.style.opacity = '1'; k.style.left = '${x}px'; k.style.top = '${y}px'; } })()`);
  await sleep(820);
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await sleep(Math.max(0, settle - 820));
}
async function clickAt(x, y) {
  await js(`(() => { const k = document.getElementById('__cur'); k?.classList.add('down'); const r = document.createElement('div'); r.className = '__ring'; r.style.left = '${x}px'; r.style.top = '${y}px'; document.body.appendChild(r); setTimeout(() => { k?.classList.remove('down'); r.remove(); }, 650); })()`);
  await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await sleep(90);
  await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}
const cursorHide = () => js(`(() => { const k = document.getElementById('__cur'); if (k) k.style.opacity = '0'; })()`);
const centerOf = (finder) => js(`(() => { const e = ${finder}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
async function glideClick(finder, settle = 500) {
  const p = await centerOf(finder);
  if (!p) throw new Error("not found: " + finder.slice(0, 90));
  await glide(p.x, p.y);
  await clickAt(p.x, p.y);
  await sleep(settle);
}
const rectOf = async (finder) => {
  const r = await b.rectOf(finder);
  return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
};
const ease = (finder, to, ms, prop = "scrollTop") => js(`window.__ease(${finder ?? "document.scrollingElement"}, '${prop}', ${to}, ${ms})`);
const docY = (finder) => js(`(() => { const e = ${finder}; return e ? Math.round(e.getBoundingClientRect().top + scrollY) : null; })()`);

let stopRec = null;
async function rec(name) {
  if (!want(name)) return;
  const dir = join(FRAMES, name);
  rmSync(dir, { recursive: true, force: true });
  stopRec = await b.screencast(dir);
  mark(`${name}:start`);
}
async function endRec(name) {
  if (!stopRec) return;
  mark(`${name}:end`);
  const frames = await stopRec();
  stopRec = null;
  const span = frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0;
  log(`${name}: ${frames.length} frames over ${span.toFixed(1)}s`);
}
const setMeta = (clip, data) => { meta[clip] = { deviceScale: SCALE, viewport: VIEW, ...data }; };
const save = () => {
  writeFileSync(join(ROOT, ".cache/marks.json"), JSON.stringify(marks, null, 1));
  writeFileSync(join(ROOT, ".cache/meta.json"), JSON.stringify(meta, null, 1));
};
const tlText = () => js(`document.getElementById('timeline')?.innerText ?? ''`);

try {
  // ===== 1. landing hero: the dial ==================================================
  if (want("hero")) {
    await b.goto("about:blank", 300);
    await rec("hero");
    await b.goto(BASE + "/", 200);
    await overlay();
    await sleep(11000);
    await endRec("hero");
    await b.shot(join(STILLS, "hero.png"));
    setMeta("hero", { url: "/", notes: "Landing hero from first paint; the dial animates on load." });
    save();
  }

  // ===== 2. the loop, live ===========================================================
  if (want("loop") || want("replay") || want("target")) {
    await b.goto(BASE + "/app", 3500);
    await overlay();
    const fixer = await js(`fetch('/api/meta').then((r) => r.json()).then((m) => m.fixer)`);
    log("fixer:", fixer);
    // SLO 95%, memory OFF (default), seed 42, 20 trials.
    await js(`(() => { const s = document.getElementById('slo'); s.value = '0.95'; s.dispatchEvent(new Event('change', { bubbles: true })); const m = document.getElementById('memory'); if (m.checked) m.click(); })()`);
    await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 800, y: 120 });
    await sleep(800);
    await rec("loop");
    await sleep(1200);
    const memRect = await rectOf(`document.getElementById('memory').closest('label')`);
    await glide(memRect.x + memRect.w / 2, memRect.y + memRect.h / 2, 1300);
    mark("loop_memory");
    await sleep(600);
    const btn = await rectOf(`document.getElementById('loopbtn')`);
    const controls = await rectOf(`document.querySelector('.controlbar')`);
    await glide(btn.x + btn.w / 2, btn.y + btn.h / 2, 1000);
    mark("loop_click");
    await clickAt(btn.x + btn.w / 2, btn.y + btn.h / 2);
    await sleep(400);
    await cursorHide();
    await sleep(1500); // smooth scroll to #loop
    const loopTop = await docY(`document.getElementById('loop')`);
    await ease(null, loopTop - 20, 600);
    await sleep(700);
    const rects = {
      timeline: await rectOf(`document.getElementById('timeline').closest('.card')`),
      findings: await rectOf(`document.getElementById('findings').closest('.card')`),
      stepper: await rectOf(`document.getElementById('stepper')`),
    };
    log("rects", rects);
    // Marks on what the timeline shows, polled.
    const want1 = [
      ["loop_red", /found \d+ weak links/],
      ["loop_before", /attack scorecard/],
      ["loop_blue1", /BLUE\s*attempt 1/],
      ["loop_rejected", /REJECTED/],
      ["loop_rollback", /rolled back/],
      ["loop_fixed", /FIXED/],
      ["loop_guard", /proven to guard/],
      ["loop_after", /re-attacked the final code/],
      ["loop_done", /Done\. Resilience/],
    ];
    const end = Date.now() + 420_000;
    while (Date.now() < end) {
      const t = await tlText();
      for (const [k, re] of want1) if (!marks[k + "@" + marks["loop:start"]] && re.test(t)) { mark(k); marks[k + "@" + marks["loop:start"]] = 1; }
      if (/Done\. Resilience/.test(t) || /Error:/.test(t)) break;
      await sleep(250);
    }
    for (const k of Object.keys(marks)) if (k.includes("@")) delete marks[k];
    const tl = await tlText();
    if (/Error:/.test(tl)) throw new Error("loop error: " + tl.slice(-300));
    await sleep(2500);
    // The Result card.
    const resRect = await rectOf(`document.getElementById('results')`);
    rects.results = resRect;
    mark("loop_result");
    await sleep(3500);
    // Up to the stat cards.
    await ease(null, 0, 1400);
    await sleep(400);
    rects.stats = await rectOf(`document.getElementById('stats')`);
    rects.controls = controls;
    mark("loop_stats");
    await sleep(3000);
    await endRec("loop");
    await js(`scrollTo(0, ${loopTop - 20})`);
    await sleep(500);
    if (want("loop")) await b.shot(join(STILLS, "loop-done.png"));
    const tlLines = tl.split("\n").filter(Boolean);
    if (want("loop")) setMeta("loop", { url: "/app", fixer, loopScrollY: loopTop - 20, rects, timeline: tlLines, notes: "rects: timeline/findings/stepper/results at loopScrollY; stats/controls at scrollY 0" });
    save();

    // ===== 3. replay + Compare with fix ===============================================
    if (want("replay") || !ONLY) {
      const SEED = "1286473109";
      const sel = `document.querySelector('#card-timeout-after-commit .dots.before .sq[data-seed="${SEED}"]') || document.querySelector('#card-timeout-after-commit .dots.before .sq.broken')`;
      const gy = await docY(`document.getElementById('card-timeout-after-commit')`);
      await js(`scrollTo(0, ${Math.max(0, gy - 260)})`);
      await overlay();
      await sleep(600);
      const seedUsed = await js(`(${sel})?.dataset.seed ?? null`);
      log("replay seed", seedUsed);
      await rec("replay");
      await sleep(900);
      await glideClick(sel, 1200);
      mark("replay_open");
      await cursorHide();
      for (let i = 0; i < 12; i++) {
        await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
        await b.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
        await sleep(i === 9 ? 900 : 380);
        if (i === 9) mark("replay_retry");
      }
      await sleep(1200);
      const modal = await rectOf(`document.querySelector('#replay .modal-box')`);
      await glideClick(`document.querySelector('#rpTabs [data-view="diff"]')`, 300);
      mark("replay_diff");
      await cursorHide();
      await sleep(2600);
      const div = `document.querySelector('#rpDiff .div, #rpDiff .df-row.diverge, #rpDiff [data-diverge], #rpDiff .mark')`;
      const dfScroll = `document.getElementById('dfScroll')`;
      const hasScroll = await js(`!!${dfScroll} && ${dfScroll}.scrollHeight > ${dfScroll}.clientHeight`);
      if (hasScroll) { const top = await js(`${dfScroll}.scrollTop`); await ease(dfScroll, top + 360, 2400); mark("replay_scroll"); }
      await sleep(4000);
      const diffRect = await rectOf(`document.getElementById('rpDiff')`);
      await endRec("replay");
      await b.shot(join(STILLS, "replay-diff.png"));
      setMeta("replay", { url: "/app", seed: seedUsed, rects: { modal, diff: diffRect } });
      await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await b.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await sleep(600);
      save();
    }

    // ===== 4. target switch =============================================================
    if (want("target") || !ONLY) {
      await js(`scrollTo(0, 0)`);
      await overlay();
      await sleep(600);
      await rec("target");
      await sleep(900);
      const tg = `[...document.querySelectorAll('#tg [data-target], #tg span, #tg button')].find((e) => e.textContent.trim() === 'researchbot')`;
      const tgRect = await rectOf(`document.getElementById('tg')`);
      await glideClick(tg, 300);
      mark("target_click");
      await cursorHide();
      await sleep(2200);
      await ease(null, 520, 1600);
      mark("target_rules");
      await sleep(3000);
      await endRec("target");
      await b.shot(join(STILLS, "target-researchbot.png"));
      setMeta("target", { url: "/app?target=researchbot", rects: { tg: tgRect } });
      save();
    }
  }

  // ===== 5. cfo.ai ======================================================================
  if (want("cfo")) {
    await b.goto("about:blank", 300);
    await b.goto(CFO, 12000);
    // Dismiss the share page's sign-in card and trial banner (viewer chrome, not the plan).
    const dismiss = () => js(`(() => {
      let n = 0;
      for (const t of ['Keep your access', 'Like what you see?']) {
        const el = [...document.querySelectorAll('div, section, aside')].filter((e) => e.textContent.trim().startsWith(t)).sort((a, b) => a.textContent.length - b.textContent.length)[0];
        let box = el; for (let i = 0; i < 6 && box; i++, box = box.parentElement) { const btn = [...box.querySelectorAll('button')].find((x) => /close|dismiss/i.test(x.getAttribute('aria-label') ?? '') || x.textContent.trim() === '' || x.textContent.trim() === '×'); if (btn) { btn.click(); n++; break; } }
      }
      return n;
    })()`);
    log("cfo dismissed", await dismiss());
    await sleep(1500);
    log("cfo dismissed", await dismiss());
    await sleep(1000);
    await overlay();
    await b.shot(join(STILLS, "cfo-0.png"));
    const sc = await js(`(() => { const all = [...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)); all.sort((a, b) => b.clientHeight - a.clientHeight); if (all[0]) all[0].id ||= '__sc'; return all[0] ? { id: all[0].id, h: all[0].scrollHeight, c: all[0].clientHeight } : null; })()`);
    // Where the ARR / cash chart sits inside the scroller.
    const chartY = sc ? await js(`(() => { const s = document.getElementById('${sc.id}'); const c = [...s.querySelectorAll('canvas, svg.recharts-surface, svg')].filter((e) => e.getBoundingClientRect().width > 400).sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0]; if (!c) return null; return Math.round(c.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop); })()`) : null;
    log("cfo scroller", sc, "chartY", chartY);
    await rec("cfo");
    await sleep(3500);
    mark("cfo_summary");
    if (sc) {
      const to = Math.min(sc.h - sc.c, chartY != null ? Math.max(0, chartY - 120) : 700);
      await ease(`document.getElementById('${sc.id}')`, to, 4500);
      mark("cfo_chart");
      await sleep(4500);
    } else { await ease(null, 700, 5000); }
    await sleep(1500);
    await endRec("cfo");
    await b.shot(join(STILLS, "cfo-1.png"));
    setMeta("cfo", { url: CFO, scroller: sc });
    save();
  }
} catch (e) {
  log("FAILED:", e.stack || e.message);
  if (stopRec) { try { await stopRec(); } catch {} }
  process.exitCode = 1;
} finally {
  save();
  log("console:", b.consoleLines.slice(0, 8));
  clearTimeout(hardStop);
  b.close();
}
