// High-quality finals from the ProRes HQ master (out/master-prores.mov, rendered by render-final.sh):
//   out/bulwark-demo-4k.mp4     3840x2160, H.264 2-pass ~45 Mbps (YouTube 2160p30 guidance), yuv420p
//   out/bulwark-demo-1080p.mp4  1920x1080 Lanczos, H.264 2-pass ~14 Mbps (for X), yuv420p
// Audio for both: two-pass loudnorm to -14 LUFS, true peak <= -1 dBTP, AAC 320k 48 kHz.
import { spawnSync, execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = new URL("..", import.meta.url).pathname;
const src = join(ROOT, "out/master-prores.mov");
const ln = "loudnorm=I=-14:TP=-1.0:LRA=11";
const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", src, "-vn", "-af", `${ln}:print_format=json`, "-f", "null", "-"], { encoding: "utf8" });
const m = JSON.parse(r.stderr.slice(r.stderr.lastIndexOf("{"), r.stderr.lastIndexOf("}") + 1));
const af = `${ln}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
console.log(`master audio: ${m.input_i} LUFS, TP ${m.input_tp}`);

function encode(out, vf, kbps) {
  const log = join(tmpdir(), `bulwark-2pass-${kbps}`);
  const v = ["-c:v", "libx264", "-preset", "slow", "-b:v", `${kbps}k`, "-maxrate", `${Math.round(kbps * 1.25)}k`, "-bufsize", `${kbps * 2}k`, "-pix_fmt", "yuv420p", "-profile:v", "high", "-r", "30", "-passlogfile", log];
  const vfa = vf ? ["-vf", vf] : [];
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", src, ...vfa, ...v, "-pass", "1", "-an", "-f", "mp4", "/dev/null"]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", src, ...vfa, ...v, "-pass", "2", "-af", af, "-ar", "48000", "-c:a", "aac", "-b:a", "320k", "-movflags", "+faststart", join(ROOT, out)]);
  console.log(`wrote ${out}`);
}
encode("out/bulwark-demo-4k.mp4", null, 45000);
encode("out/bulwark-demo-1080p.mp4", "scale=1920:1080:flags=lanczos", 14000);
