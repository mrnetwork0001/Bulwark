// Tiles out/stills/f<frame>.png into a contact sheet: node scripts/sheet.mjs out/sheet.png 120 330 ...
// (4 columns, each still scaled to 480 px wide)
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const [out, ...frames] = process.argv.slice(2);
const cols = 4;
const inputs = frames.flatMap((f) => ["-i", join(ROOT, "out/stills", `f${f}.png`)]);
const n = frames.length;
const scaled = frames.map((_, i) => `[${i}]scale=480:270[s${i}]`).join(";");
const layout = frames.map((_, i) => `${(i % cols) * 480}_${Math.floor(i / cols) * 270}`).join("|");
const fc = `${scaled};${frames.map((_, i) => `[s${i}]`).join("")}xstack=inputs=${n}:layout=${layout}:fill=gray`;
execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", fc, join(ROOT, out)]);
console.log(join(ROOT, out));
