// Auditions candidate narrators on one line from the script -> .cache/audition/<name>.mp3,
// and prints each take's pace (chars/s, words/s). Never prints the key.
//   node scripts/audition.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, post } from "./env.mjs";

const LINE = "Bulwark breaks it first. It's chaos engineering for AI agents. It attacks your agent before your users do, writes the fix, and only accepts it when an independent Judge proves it.";
const CANDIDATES = {
  sarah: "EXAVITQu4vr4xnSDxMaL", // Mature, Reassuring, Confident
  lily: "pFZP5JQG7iQjIQuC4Bku", // Velvety Actress, confident, British
  alice: "Xb7hH8MSUJpSbSDYk0k2", // Clear, Engaging Educator, British
};
const dir = join(ROOT, ".cache/audition");
mkdirSync(dir, { recursive: true });
for (const [name, id] of Object.entries(CANDIDATES)) {
  const res = await post(`/text-to-speech/${id}/with-timestamps?output_format=mp3_44100_128`, {
    text: LINE, model_id: "eleven_multilingual_v2",
    voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true },
  });
  const body = await res.json();
  writeFileSync(join(dir, `${name}.mp3`), Buffer.from(body.audio_base64, "base64"));
  const a = body.alignment;
  const speech = a.character_end_times_seconds.at(-1) - a.character_start_times_seconds[0];
  console.log(`${name.padEnd(6)} ${speech.toFixed(2)}s  ${(LINE.length / speech).toFixed(1)} cps  ${(LINE.split(" ").length / speech).toFixed(2)} wps`);
}
