import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { T } from "../timing";
import { mono, SCENE_LABEL, SCENE_TONE, TONE } from "../theme";
import { clamp } from "./motion";

const tc = (f: number) => {
  const s = Math.floor(f / 30);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `00:${pad(Math.floor(s / 60))}:${pad(s % 60)}:${pad(f % 30)}`;
};

/** Corner furniture in the reference film's manner: a scene tag, the file and its timecode. */
export const Chrome: React.FC<{ hideAfter?: number }> = ({ hideAfter }) => {
  const f = useCurrentFrame();
  const sc = T.scenes.find((s) => f >= s.from && f < s.from + s.durationInFrames) ?? T.scenes[T.scenes.length - 1];
  const tone = TONE[SCENE_TONE[sc.id] ?? "light"];
  const local = f - sc.from;
  const tagIn = interpolate(local, [4, 16], [0, 1], clamp);
  const op = hideAfter != null ? interpolate(f, [hideAfter, hideAfter + 12], [1, 0], clamp) : 1;
  const base: React.CSSProperties = { position: "absolute", fontFamily: mono, fontSize: 15, letterSpacing: "0.04em", color: tone.muted, opacity: op };
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ ...base, left: 48, top: 36 }}>
        <span style={{ opacity: 0.8 }}>// bulwark</span>
        <span style={{ marginLeft: 18, opacity: tagIn }}>{SCENE_LABEL[sc.id]}</span>
      </div>
      <div style={{ ...base, right: 48, top: 36 }}>BULWARK_DEMO.MOV&nbsp;&nbsp;{tc(f)}</div>
      <div style={{ ...base, left: 48, bottom: 34, fontSize: 13 }}>#neathack 2026 · chaos engineering for ai agents</div>
      <div style={{ ...base, right: 48, bottom: 34, fontSize: 13 }}>github.com/mrnetwork0001/Bulwark</div>
    </AbsoluteFill>
  );
};
