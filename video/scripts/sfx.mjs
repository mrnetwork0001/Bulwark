// Sound effects via ElevenLabs /v1/sound-generation. Skips files that already exist.
//   node scripts/sfx.mjs                 all missing
//   ONLY=stamp,impact node scripts/sfx.mjs   force regenerate some
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, post, retry } from "./env.mjs";

const SFX = {
  tick: ["Single crisp clock tick, close, dry, short", 0.5],
  alarm: ["Short low digital alarm pulse, two tones, tense, clean, no music", 1.2],
  glitch: ["Short digital glitch burst, crisp static, single", 0.6],
  thud: ["Heavy stone block knocked out of a wall, deep thud with a little crumble, close", 1.0],
  slot: ["Stone block sliding firmly into place with a solid locking clunk, satisfying, close", 0.9],
  wobble: ["Stone block wobbling and rattling then dropping out with a dull thud", 1.4],
  whoosh: ["Soft fast airy whoosh, smooth cinematic transition, no music", 0.8],
  riser: ["Tension riser, rising airy synth swell building to a peak, cinematic, no drums", 2.5],
  impact: ["Deep clean cinematic impact like a heavy gate closing, warm sub tail, single hit", 2],
  click: ["Soft modern UI click, single, clean, short", 0.5],
  pop: ["Soft UI pop, single, clean, short", 0.5],
  stamp: ["Firm rubber stamp hit on paper, single, close, dry", 0.6],
  chime: ["Bright clean confirmation chime, two soft ascending notes, modern, short tail", 1.5],
  cash: ["Two quick soft digital coin blips like a payment going through, clean UI sound", 0.7],
  typing: ["Fast soft keyboard typing, close, dry, no music", 2.0],
};

const dir = join(ROOT, "public/audio/sfx");
mkdirSync(dir, { recursive: true });
const only = process.env.ONLY ? process.env.ONLY.split(",") : null;

for (const [name, [text, dur]] of Object.entries(SFX)) {
  const f = join(dir, `${name}.mp3`);
  if (only ? !only.includes(name) : existsSync(f)) { console.log(`${name}: skip`); continue; }
  try {
    const buf = await retry(async () => {
      const res = await post("/sound-generation?output_format=mp3_44100_128", { text, duration_seconds: dur, prompt_influence: 0.5 });
      return Buffer.from(await res.arrayBuffer());
    });
    writeFileSync(f, buf);
    console.log(`${name}: ${(buf.length / 1024).toFixed(0)}kb`);
  } catch (e) { console.error(`${name}: FAILED ${e.message}`); }
}
