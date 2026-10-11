import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { T } from "../timing";
import { mono, SCENE_TONE, TONE } from "../theme";
import { clamp } from "./motion";

/** Bottom-corner footer only: the event line and the repo. (The top scene tag and timecode were removed on request.) */
export const Chrome: React.FC<{ hideAfter?: number }> = ({ hideAfter }) => {
  const f = useCurrentFrame();
  const sc = T.scenes.find((s) => f >= s.from && f < s.from + s.durationInFrames) ?? T.scenes[T.scenes.length - 1];
  const tone = TONE[SCENE_TONE[sc.id] ?? "light"];
  const op = hideAfter != null ? interpolate(f, [hideAfter, hideAfter + 12], [1, 0], clamp) : 1;
  const base: React.CSSProperties = { position: "absolute", fontFamily: mono, fontSize: 13, letterSpacing: "0.04em", color: tone.muted, opacity: op };
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ ...base, left: 48, bottom: 34 }}>#neathack 2026 · chaos engineering for ai agents</div>
      <div style={{ ...base, right: 48, bottom: 34 }}>github.com/mrnetwork0001/Bulwark</div>
    </AbsoluteFill>
  );
};
