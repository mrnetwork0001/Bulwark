// Hosted demo (Vercel has no Bulwark server): the app's /api calls are answered from runs recorded
// on the local server by scripts/record-hosted-demo.mjs. Every event, replay and diff is real output;
// only the long waits between events are shortened. Run it live locally: npm run dashboard.
(() => {
  const MAX_GAP_MS = 1200; // a recorded 8-minute loop plays in about a minute
  const realFetch = window.fetch.bind(window);
  let index = null;
  const indexP = realFetch('/demo/index.json').then((r) => r.json()).then((j) => (index = j));

  const targetOf = (params) => params.get('target') || new URLSearchParams(location.search).get('target') || 'refundbot';
  const sha1 = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
    const p = url.searchParams, t = targetOf(p);
    if (url.pathname === '/api/meta') return realFetch(`/demo/${t}/meta.json`);
    if (url.pathname === '/api/replay' || url.pathname === '/api/diff') {
      const kind = url.pathname.slice(5);
      const res = await realFetch(`/demo/${t}/${kind}/${await sha1(p.toString())}.json`);
      if (!res.ok) return json({ error: `This trial wasn't part of the recorded run. Run Bulwark locally (npm run dashboard) to ${kind} any trial.` }, 404);
      const { status, body } = await res.json();
      return json(body, status);
    }
    return json({ error: 'Not available on the hosted demo. Run Bulwark locally: npm run dashboard.' }, 404);
  };

  // EventSource stand-in that plays a recorded stream with its original order and shortened gaps.
  class RecordedEventSource {
    constructor(src) {
      this.listeners = {};
      this.closed = false;
      this.onerror = null;
      const url = new URL(src, location.href);
      const kind = url.pathname === '/api/loop' ? 'loop' : 'run';
      const t = targetOf(url.searchParams);
      realFetch(`/demo/${t}/${kind}.json`).then((r) => r.json()).then(async (events) => {
        let last = 0;
        for (const e of events) {
          await new Promise((r) => setTimeout(r, Math.min(MAX_GAP_MS, Math.max(0, e.t - last))));
          last = e.t;
          if (this.closed) return;
          this.emit(e.event, JSON.stringify(e.data));
          if (e.data?.type === 'run-done') setTimeout(() => { const b = document.getElementById('badge'); if (b) b.src = `/demo/${t}/badge.svg`; }, 50);
        }
      });
    }
    emit(type, data) { for (const fn of this.listeners[type] ?? []) fn(new MessageEvent(type, { data })); }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn); }
    close() { this.closed = true; }
  }
  window.EventSource = RecordedEventSource;

  // Result-card links point at /api/artifact?run=…&file=…; serve the recorded copies.
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest?.('a[href^="/api/artifact"]');
    if (!a) return;
    const p = new URL(a.href).searchParams;
    const t = index && Object.entries(index.targets).find(([, v]) => v.runId === p.get('run'))?.[0];
    if (t) a.href = `/demo/${t}/artifacts/${encodeURIComponent(p.get('file'))}`;
  }, true);

  // Say plainly what this page is.
  const banner = () => {
    const el = document.createElement('div');
    el.className = 'demo-banner';
    el.innerHTML = `<span><b>Recorded run</b> · a real Bulwark run, played back with the waits shortened</span><a href="https://github.com/mrnetwork0001/Bulwark#quickstart" target="_blank" rel="noopener">Run it live ↗</a>`;
    document.body.prepend(el);
  };
  const style = document.createElement('style');
  style.textContent = '.demo-banner{display:flex;justify-content:center;gap:14px;font:12.5px/1.4 Inter,system-ui,sans-serif;background:#0a0a0a;color:rgba(255,255,255,.72);padding:7px var(--gutter,16px);white-space:nowrap}.demo-banner span{overflow:hidden;text-overflow:ellipsis}.demo-banner b{color:#fff;font-weight:500}.demo-banner a{color:#fff;text-decoration:none;flex:none}.demo-banner a:hover{text-decoration:underline}';
  document.head.append(style);
  // Show the settings the recordings were made with, and lock them.
  const lockControls = () => {
    const set = { trials: '20', seed: '42', slo: '0.95', tournament: '' };
    for (const [id, v] of Object.entries(set)) {
      const el = document.getElementById(id);
      if (el) { el.value = v; el.disabled = true; el.title = 'Fixed to the recorded run on the hosted demo'; }
    }
    const mem = document.getElementById('memory');
    if (mem) { mem.checked = false; mem.disabled = true; }
  };
  const ready = () => { lockControls(); indexP.finally(banner); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();
