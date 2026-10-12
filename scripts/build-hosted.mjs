// Vercel build: the landing page plus a hosted /app that replays recorded runs (see bulwark/dashboard/demo.js).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const D = 'bulwark/dashboard', OUT = '.vercel-site';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);
cpSync(`${D}/landing.html`, `${OUT}/index.html`);
for (const f of ['theme.css', 'menu.js', 'demo.js']) cpSync(`${D}/${f}`, `${OUT}/${f}`);
cpSync(`${D}/demo`, `${OUT}/demo`, { recursive: true });
const app = readFileSync(`${D}/index.html`, 'utf8');
if (!app.includes('<script>')) throw new Error('index.html: no inline <script> to hook before');
// The live Bulwark server (VPS, see scripts/deploy/vps-setup.sh). Not a secret. On Vercel it defaults to ours;
// BULWARK_API_URL overrides it, and an empty value means recorded runs only.
const API_URL = process.env.BULWARK_API_URL ?? (process.env.VERCEL ? 'https://bulwark.38.49.216.120.sslip.io' : '');
const api = API_URL ? `<script>window.BULWARK_API = ${JSON.stringify(API_URL)};</script>\n` : '';
writeFileSync(`${OUT}/app.html`, app.replace('<script>', `${api}<script src="/demo.js"></script>\n<script>`));
console.log('hosted site built in', OUT, API_URL ? `(live API: ${API_URL})` : '(recorded runs only)');
