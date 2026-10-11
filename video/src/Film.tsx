import React from "react";
import { AbsoluteFill, Audio, Freeze, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import { T, scene, wordAt } from "./timing";
import { C } from "./theme";
import { Chrome } from "./ui/Chrome";
import { Captions } from "./ui/Captions";
import { Grain } from "./ui/Grain";
import { clamp } from "./ui/motion";
import { Open } from "./scenes/Open";
import { Problem } from "./scenes/Problem";
import { Turn } from "./scenes/Turn";
import { Attack } from "./scenes/Attack";
import { Fix } from "./scenes/Fix";
import { Prove } from "./scenes/Prove";
import { Result } from "./scenes/Result";
import { Tools } from "./scenes/Tools";
import { Different } from "./scenes/Different";
import { Close } from "./scenes/Close";

const SCENES: Record<string, React.FC> = {
  open: Open, problem: Problem, turn: Turn, attack: Attack, fix: Fix,
  prove: Prove, result: Result, tools: Tools, different: Different, close: Close,
};
const OVERLAP = 10; // frames each scene starts early, to cross-dissolve with the last

/** Each scene eases in (a short settle and un-blur) over the tail of the previous one, holding its first frame. */
const SceneIn: React.FC<{ S: React.FC; first: boolean }> = ({ S, first }) => {
  const f = useCurrentFrame();
  if (first) return <S />;
  const p = interpolate(f, [0, OVERLAP], [0, 1], { ...clamp, easing: (t) => 1 - Math.pow(1 - t, 3) });
  const body = f < OVERLAP ? <Freeze frame={0}><S /></Freeze> : <Sequence from={OVERLAP} layout="none"><S /></Sequence>;
  return <AbsoluteFill style={{ opacity: p, transform: `scale(${1.03 - 0.03 * p})`, filter: p < 1 ? `blur(${(1 - p) * 10}px)` : undefined }}>{body}</AbsoluteFill>;
};

// --- Music: ducked under every spoken line.
const LINES = T.scenes.flatMap((s) => s.lines.map((l) => [l.startFrame, l.words[l.words.length - 1].end] as const));
const DUCK: number[] = (() => {
  const v = new Array<number>(T.totalFrames + 1).fill(0);
  for (let f = 0; f <= T.totalFrames; f++) {
    let d = 0;
    for (const [a, b] of LINES) d = Math.max(d, interpolate(f, [a - 10, a, b, b + 14], [0, 1, 1, 0], clamp));
    v[f] = d;
  }
  return v;
})();
const musicVolume = (f: number) => {
  const end = T.totalFrames;
  const fadeIn = interpolate(f, [0, 20], [0, 1], clamp);
  const fadeOut = interpolate(f, [end - 50, end], [1, 0], clamp);
  return (0.5 - 0.33 * DUCK[Math.min(end, Math.max(0, f))]) * fadeIn * fadeOut;
};

interface Fx { file: string; at: number; vol: number; dur?: number }
function effects(): Fx[] {
  const sc = (id: string) => scene(id).from;
  const w = (id: string, word: string, n = 0) => wordAt(id, word, n);
  const fx: Fx[] = [
    // open: the trial
    { file: "tick", at: 4, vol: 0.3 }, { file: "tick", at: 34, vol: 0.3 },
    { file: "click", at: w("open", "refund") - 6, vol: 0.3 },
    { file: "cash", at: w("open", "through,") - 6, vol: 0.4 },
    { file: "glitch", at: w("open", "slow.") - 12, vol: 0.3 },
    ...[0, 12, 24].map((d) => ({ file: "tick", at: w("open", "slow.") + 6 + d, vol: 0.25 })),
    { file: "alarm", at: w("open", "gives") - 4, vol: 0.32 },
    { file: "cash", at: w("open", "again.") + 4, vol: 0.4 },
    { file: "thud", at: w("open", "again."), vol: 0.5 },
    { file: "impact", at: w("open", "Ninety-eight") - 4, vol: 0.5 },
    // problem: the wall is knocked apart
    { file: "whoosh", at: sc("problem") - 6, vol: 0.25 },
    ...[1, 2, 3, 4, 5, 6, 7].map((k) => ({ file: "thud", at: w("problem", "Under") + 8 + (k - 1) * 12, vol: 0.22 })),
    { file: "riser", at: sc("turn") - 70, vol: 0.32 },
    // turn: the wall builds itself
    ...Array.from({ length: 6 }, (_, k) => ({ file: "slot", at: sc("turn") - 6 + k * 4, vol: 0.18 })),
    { file: "impact", at: w("turn", "Bulwark") - 2, vol: 0.5 },
    ...["attacks", "writes", "independent"].map((x) => ({ file: "pop", at: w("turn", x) - 1, vol: 0.35 })),
    // attack
    { file: "whoosh", at: sc("attack") - 6, vol: 0.25 },
    { file: "click", at: sc("attack") + 22, vol: 0.45 },
    ...["Timeouts.", "Rate", "Prompt", "A"].map((x) => ({ file: "pop", at: w("attack", x, x === "A" ? 1 : 0) - 1, vol: 0.35 })),
    // fix: the brick wobbles and falls
    { file: "whoosh", at: sc("fix") - 6, vol: 0.25 },
    { file: "slot", at: w("fix", "fix", 1), vol: 0.35 },
    { file: "wobble", at: w("fix", "still"), vol: 0.4 },
    { file: "stamp", at: w("fix", "Rejected.") - 2, vol: 0.55 },
    { file: "glitch", at: w("fix", "Rolled") - 2, vol: 0.25 },
    // prove
    { file: "wobble", at: w("prove", "three"), vol: 0.3 },
    { file: "stamp", at: w("prove", "Rejected") - 2, vol: 0.4 },
    { file: "slot", at: w("prove", "passes") + 2, vol: 0.45 },
    { file: "chime", at: w("prove", "fifty-nine"), vol: 0.35 },
    { file: "whoosh", at: w("prove", "Same") - 16, vol: 0.25 },
    { file: "pop", at: w("prove", "gone.") - 6, vol: 0.4 },
    // result: red to green, the wall closes
    { file: "alarm", at: sc("result") + 2, vol: 0.25 },
    ...Array.from({ length: 8 }, (_, k) => ({ file: "slot", at: w("result", "one") - 6 + k * 3, vol: 0.2 })),
    { file: "impact", at: w("result", "one") - 2, vol: 0.45 },
    { file: "chime", at: w("result", "zero.") - 2, vol: 0.35 },
    // tools
    { file: "whoosh", at: sc("tools") - 6, vol: 0.25 },
    { file: "whoosh", at: w("tools", "Entire") - 16, vol: 0.25 },
    { file: "typing", at: w("tools", "Entire") - 6, vol: 0.16 },
    { file: "whoosh", at: w("tools", "And", 1) - 14, vol: 0.25 },
    // different
    { file: "whoosh", at: sc("different") - 6, vol: 0.25 },
    ...[["ResearchBot,", 24], ["Several", 6], ["Bulwark", 8]].map(([x, d]) => ({ file: "pop", at: w("different", x as string) - (d as number), vol: 0.35 })),
    { file: "chime", at: w("different", "recovered.") - 4, vol: 0.3 },
    // close
    { file: "whoosh", at: sc("close") - 6, vol: 0.25 },
    { file: "impact", at: w("close", "Bulwark.") - 2, vol: 0.4 },
    { file: "chime", at: w("close", "watching.") + 4, vol: 0.3 },
  ];
  return fx.filter((x) => x.at >= 0 && x.at < T.totalFrames);
}

export const Film: React.FC = () => {
  // Captions sit out where big type already carries the words.
  const hideCaptions = (f: number) => {
    const s = T.scenes.find((x) => f >= x.from && f < x.from + x.durationInFrames);
    if (!s) return true;
    if (["turn", "result", "close"].includes(s.id)) return true;
    if (s.id === "open" && f >= wordAt("open", "Ninety-eight") - 6) return true;
    if (s.id === "problem") return true;
    return false;
  };
  return (
    <AbsoluteFill style={{ background: C.paper }}>
      {T.scenes.map((s, i) => {
        const S = SCENES[s.id];
        const from = i === 0 ? s.from : s.from - OVERLAP;
        const dur = s.durationInFrames + (i === 0 ? 0 : OVERLAP);
        return S ? (
          <Sequence key={s.id} from={from} durationInFrames={dur} name={s.id}>
            <SceneIn S={S} first={i === 0} />
          </Sequence>
        ) : null;
      })}
      <Grain opacity={0.045} />
      <Chrome hideAfter={scene("close").from + 30} />
      <Captions hidden={hideCaptions} />
      <Audio src={staticFile("audio/music.mp3")} volume={musicVolume} />
      {T.scenes.flatMap((s) => s.lines).map((l, i) => (
        <Sequence key={`vo${i}`} from={l.startFrame} durationInFrames={l.durationFrames} name={`vo ${l.text.slice(0, 18)}`}>
          <Audio src={staticFile(l.file)} volume={1} />
        </Sequence>
      ))}
      {effects().map((x, i) => (
        <Sequence key={`fx${i}`} from={x.at} durationInFrames={x.dur ?? 150} name={`fx ${x.file}`}>
          <Audio src={staticFile(`audio/sfx/${x.file}.mp3`)} volume={(f) => x.vol * (x.dur ? interpolate(f, [0, 8, x.dur - 20, x.dur], [0, 1, 1, 0], clamp) : 1)} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
