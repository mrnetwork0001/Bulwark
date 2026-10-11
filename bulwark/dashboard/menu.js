// Mobile menu shared by the landing page and the app: a "+ Menu" pill that opens a
// full-screen sheet below 768px. Each page configures it with window.BULWARK_MENU:
//   { card?: { eyebrow, stats: [[value, label]], note }, sections?: [{ heading, move: selector }],
//     rows: [{ href, label, hint, icon }], cta?: { href, label } }
// `sections.move` lends an existing element (e.g. the app's target switch) to the sheet
// while it is open and puts it back on close, so controls never exist twice.
(function () {
  const cfg = window.BULWARK_MENU;
  const pill = document.querySelector('[data-menu-open]');
  if (!cfg || !pill) return;

  const ICONS = {
    grid: '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>',
    bug: '<rect x="4.5" y="5" width="7" height="8.5" rx="3.5"/><path d="M8 5v8.5M2.5 8.5h2M11.5 8.5h2M3.5 4.5l1.5 1.5M12.5 4.5L11 6M3.5 12.5L5 11M12.5 12.5L11 11"/>',
    loop: '<path d="M3 8a5 5 0 0 1 8.5-3.5L13 6M13 2.5V6H9.5M13 8a5 5 0 0 1-8.5 3.5L3 10M3 13.5V10h3.5"/>',
    bolt: '<path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z"/>',
    chart: '<path d="M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5"/>',
    layers: '<path d="M8 2l6 3.25L8 8.5 2 5.25zM2 8l6 3.25L14 8M2 10.75L8 14l6-3.25"/>',
    home: '<path d="M2.5 7.5L8 3l5.5 4.5M4 6.5v6.5h8V6.5"/>',
    timeline: '<path d="M4 3v10M4 4.5h7.5M4 8h5M4 11.5h8"/>',
    play: '<path d="M5 3.5l7 4.5-7 4.5z"/>',
    doc: '<path d="M4 2h5.5L12 4.5V14H4zM9.5 2v2.5H12M6 8h4M6 10.5h4"/>',
  };
  const svg = (name, size = 16) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.grid}</svg>`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const plus = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.5v9M1.5 6h9" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
  const arrowUpRight = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M4 10 10 4M5 4h5v5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const chev = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7h8M7.5 3.5L11 7l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const brand = document.querySelector('.topbar .brand');

  let sheet = null;
  let borrowed = [];

  function open() {
    if (sheet) return;
    const here = location.pathname + location.hash;
    sheet = document.createElement('div');
    sheet.className = 'msheet';
    sheet.id = 'bulwark-menu';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', 'bulwark-menu-title');
    const cardCfg = typeof cfg.card === 'function' ? cfg.card() : cfg.card;
    const card = cardCfg
      ? `<div class="ms-card"><span class="ms-eyebrow">${esc(cardCfg.eyebrow)}</span><div class="ms-stats">${(cardCfg.stats || [])
          .map(([v, l]) => `<div class="ms-stat"><span>${esc(l)}</span><b>${esc(v)}</b></div>`)
          .join('')}</div>${cardCfg.note ? `<p class="ms-note">${esc(cardCfg.note)}</p>` : ''}</div>`
      : '';
    const sections = (cfg.sections || [])
      .map((s, i) => `<section class="ms-section"><h3 class="ms-heading">${esc(s.heading)}</h3><div class="ms-slot" data-slot="${i}"></div></section>`)
      .join('');
    const rows = (cfg.rows || [])
      .map(
        (r) => `<li><a class="ms-row" href="${esc(r.href)}"${r.href === here || r.href === location.pathname ? ' aria-current="page"' : ''}>
          <span class="ms-ri">${svg(r.icon)}</span>
          <span class="ms-rt"><span class="ms-rl">${esc(r.label)}</span><span class="ms-rh">${esc(r.hint)}</span></span>
          <span class="ms-chev">${chev}</span></a></li>`,
      )
      .join('');
    sheet.innerHTML = `
      <h2 id="bulwark-menu-title" class="sr-only">Menu</h2>
      <div class="ms-top">
        ${brand ? brand.outerHTML : ''}
        <button type="button" class="menu-pill ms-close" style="display:inline-flex"><span class="mi">${plus}</span><span class="ml">Close</span></button>
      </div>
      <div class="ms-body">
        ${card}
        ${sections}
        <nav class="ms-section" aria-label="Site"><h3 class="ms-heading">Go to</h3><ul class="ms-list">${rows}</ul></nav>
      </div>
      ${cfg.cta ? `<div class="ms-foot"><a class="ms-cta" href="${esc(cfg.cta.href)}">${esc(cfg.cta.label)} <span class="mi">${arrowUpRight}</span></a></div>` : ''}`;
    document.body.appendChild(sheet);

    // Lend live controls (e.g. the target switch) to the sheet; remember where they came from.
    borrowed = (cfg.sections || []).map((s, i) => {
      const el = document.querySelector(s.move);
      if (!el) return null;
      const home = { parent: el.parentNode, next: el.nextSibling, display: el.style.display };
      sheet.querySelector(`[data-slot="${i}"]`).appendChild(el);
      el.style.display = '';
      return { el, home };
    });

    document.documentElement.style.overflow = 'hidden';
    pill.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => {
      sheet.classList.add('open');
      sheet.querySelector('.ms-close').focus({ preventScroll: true });
    });
    sheet.querySelector('.ms-close').addEventListener('click', () => close(true));
    sheet.addEventListener('click', (e) => {
      const a = e.target.closest('a');
      if (a) close(false);
    });
    sheet.addEventListener('keydown', onKey);
  }

  function close(returnFocus) {
    if (!sheet) return;
    const s = sheet;
    sheet = null;
    for (const b of borrowed) {
      if (!b) continue;
      b.home.parent.insertBefore(b.el, b.home.next);
      b.el.style.display = b.home.display;
    }
    borrowed = [];
    document.documentElement.style.overflow = '';
    pill.setAttribute('aria-expanded', 'false');
    s.classList.add('closing');
    s.classList.remove('open');
    setTimeout(() => s.remove(), 450);
    if (returnFocus) pill.focus({ preventScroll: true });
  }

  function onKey(e) {
    if (e.key === 'Escape') return close(true);
    if (e.key !== 'Tab' || !sheet) return;
    const items = [...sheet.querySelectorAll('a[href], button:not([disabled]), input, select, [tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  pill.setAttribute('aria-controls', 'bulwark-menu');
  pill.setAttribute('aria-expanded', 'false');
  pill.addEventListener('click', open);
  // Rotating to desktop width while open: close so the desktop nav takes over.
  matchMedia('(min-width: 768px)').addEventListener('change', (m) => m.matches && close(false));
})();
