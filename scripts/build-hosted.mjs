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
writeFileSync(`${OUT}/app.html`, app.replace('<script>', '<script src="/demo.js"></script>\n<script>'));
console.log('hosted site built in', OUT);
