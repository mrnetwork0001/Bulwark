// Hosted site (Vercel serves pages only). When the build sets window.BULWARK_API (a Bulwark server on a
// VPS, see docs/DEPLOY.md), the app's /api calls go there and runs are live. When that server is
// unreachable, or busy with another visitor's loop, the app plays runs recorded on the local server by
// scripts/record-hosted-demo.mjs instead: real events, replays and diffs, with the long waits shortened.
(() => {
  const API = (window.BULWARK_API || '').replace(/\/$/, '');
  const MAX_GAP_MS = 1200; // a recorded 8-minute loop plays in about a minute
  const realFetch = window.fetch.bind(window);
  const RealEventSource = window.EventSource;

  const timeout = (ms) => new Promise((r) => setTimeout(() => r(false), ms));
  const liveP = API
    ? Promise.race([realFetch(API + '/api/meta').then((r) => r.ok, () => false), timeout(5000)])
    : Promise.resolve(false);
  let index = null;
  const indexP = realFetch('/demo/index.json').then((r) => r.json()).then((j) => (index = j), () => null);

  const targetOf = (params) => params.get('target') || new URLSearchParams(location.search).get('target') || 'refundbot';
  const sha1 = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  async function recordedFetch(url) {
    const p = url.searchParams, t = targetOf(p);
    if (url.pathname === '/api/meta') return realFetch(`/demo/${t}/meta.json`);
    if (url.pathname === '/api/replay' || url.pathname === '/api/diff') {
      const kind = url.pathname.slice(5);
      const res = await realFetch(`/demo/${t}/${kind}/${await sha1(p.toString())}.json`);
      if (!res.ok) return json({ error: `This trial wasn't part of the recorded run. Run Bulwark locally (npm run dashboard) to ${kind} any trial.` }, 404);
      const { status, body } = await res.json();
      return json(body, status);
    }
    return json({ error: 'Not available in the recorded demo.' }, 404);
  }

  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
    if (await liveP) {
      try { return await realFetch(API + url.pathname + url.search, init); } catch { /* fall back to the recording */ }
    }
    return recordedFetch(url);
  };

  // EventSource stand-in: forwards a live stream from the API, or plays a recorded one.
  class HostedEventSource {
    constructor(src) {
      this.listeners = {};
      this.closed = false;
      this.url = new URL(src, location.href);
      this.target = targetOf(this.url.searchParams);
      liveP.then((live) => (live ? this.live() : this.recorded()));
    }
    live() {
      if (this.closed) return;
      const es = (this.es = new RealEventSource(API + this.url.pathname + this.url.search));
      let got = false;
      for (const type of Object.keys(this.listeners)) {
        es.addEventListener(type, (m) => {
          // Another visitor's loop is running: play the recording rather than make them wait.
          if (!got && type === 'loop-error' && /already running/i.test(m.data)) {
            es.close();
            return this.recorded('Someone else is running a loop on the live server right now, so this is a recorded run.');
          }
          if (type === 'error' && !got) { es.close(); return this.recorded(); }
          if (type !== 'error') got = true;
          this.emit(type, m.data);
          if (type === 'loop' && /"type":"run-done"/.test(m.data)) badge(API + '/badge.svg?t=' + Date.now());
        });
      }
      if (!this.listeners.error) es.addEventListener('error', () => { if (!got) { es.close(); this.recorded(); } });
    }
    async recorded(why) {
      if (this.closed) return;
      showBanner(why);
      const kind = this.url.pathname === '/api/loop' ? 'loop' : 'run';
      const events = await (await realFetch(`/demo/${this.target}/${kind}.json`)).json();
      let last = 0;
      for (const e of events) {
        await new Promise((r) => setTimeout(r, Math.min(MAX_GAP_MS, Math.max(0, e.t - last))));
        last = e.t;
        if (this.closed) return;
        this.emit(e.event, JSON.stringify(e.data));
        if (e.data?.type === 'run-done') badge(`/demo/${this.target}/badge.svg`);
      }
    }
    emit(type, data) { for (const fn of this.listeners[type] ?? []) fn(new MessageEvent(type, { data })); }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn); }
    close() { this.closed = true; this.es?.close(); }
  }
  window.EventSource = HostedEventSource;

  // The app sets the badge after a loop; point it at whichever server produced the run.
  const badge = (src) => setTimeout(() => { const b = document.getElementById('badge'); if (b) b.src = src; }, 50);

  // Result-card links point at /api/artifact?run=…&file=…: the live server, or the recorded copies.
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest?.('a[href*="/api/artifact"]');
    if (!a) return;
    const u = new URL(a.href), p = u.searchParams;
    const t = index && Object.entries(index.targets).find(([, v]) => v.runId === p.get('run'))?.[0];
    if (t) a.href = `/demo/${t}/artifacts/${encodeURIComponent(p.get('file'))}`;
    else if (API && u.origin === location.origin) a.href = API + u.pathname + u.search;
  }, true);

  // Recorded mode: say so in one line, and show (and lock) the settings the recordings were made with.
  let bannerShown = false;
  function showBanner(why) {
    if (bannerShown) return;
    bannerShown = true;
    const el = document.createElement('div');
    el.className = 'demo-banner';
    el.innerHTML = `<span><b>Recorded run</b> · ${why ? why.replace(/</g, '&lt;') : 'a real Bulwark run, played back with the waits shortened'}</span><a href="https://github.com/mrnetwork0001/Bulwark#quickstart" target="_blank" rel="noopener">Run it live ↗</a>`;
    document.body.prepend(el);
    const set = { trials: '20', seed: '42', slo: '0.95', tournament: '' };
    for (const [id, v] of Object.entries(set)) {
      const c = document.getElementById(id);
      if (c) { c.value = v; c.disabled = true; c.title = 'Fixed to the recorded run'; }
    }
    const mem = document.getElementById('memory');
    if (mem) { mem.checked = false; mem.disabled = true; }
  }
  const style = document.createElement('style');
  style.textContent = '.demo-banner{display:flex;justify-content:center;gap:14px;font:12.5px/1.4 Inter,system-ui,sans-serif;background:#0a0a0a;color:rgba(255,255,255,.72);padding:7px var(--gutter,16px);white-space:nowrap}.demo-banner span{overflow:hidden;text-overflow:ellipsis}.demo-banner b{color:#fff;font-weight:500}.demo-banner a{color:#fff;text-decoration:none;flex:none}.demo-banner a:hover{text-decoration:underline}';
  document.head.append(style);
  const ready = () => liveP.then((live) => { if (!live) indexP.finally(() => showBanner()); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();
