import React from "react";
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from "remotion";
import { C, inter, mono } from "../theme";
import { clamp, expo } from "../ui/motion";
import { useRel, Pill, Tag } from "../ui/kit";
import { Wall } from "../ui/Wall";
import { Words } from "../ui/Words";
import { Browser } from "../ui/Footage";

/** The wall builds itself into the logo; the thesis over the real landing page. */
export const Turn: React.FC = () => {
  const f = useCurrentFrame();
  const rel = useRel("turn");
  const tName = rel("Bulwark");
  const tIts = rel("It's");
  const word = interpolate(f, [tName - 4, tName + 14], [0, 1], { ...clamp, easing: expo });
  // Lockup: centred and big, then up and smaller for the thesis.
  const up = interpolate(f, [tIts - 16, tIts + 6], [0, 1], { ...clamp, easing: expo });
  const scale = 1 - 0.5 * up;
  const y = -40 - 330 * up;
  return (
    <AbsoluteFill style={{ background: C.paper, fontFamily: inter, color: C.ink }}>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", transform: `translateY(${y}px) scale(${scale})` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 40 }}>
          <Wall size={230} build={[-8, tName + 6]} />
          <div style={{ fontSize: 210, fontWeight: 500, letterSpacing: "-0.06em", opacity: word, clipPath: `inset(0 ${(1 - word) * 100}% 0 0)`, transform: `translateX(${(1 - word) * -30}px)` }}>Bulwark</div>
        </div>
        <div style={{ marginTop: 26, fontSize: 84, fontWeight: 300, letterSpacing: "-0.04em", opacity: 1 - up }}>
          <Words text="breaks it first." at={rel("breaks")} every={4} accent={{ "first.": C.crash }} serifScale={1.18} />
        </div>
      </AbsoluteFill>

      {/* Thesis, over the real landing page's dial */}
      <div style={{ position: "absolute", left: 0, right: 0, top: 268, textAlign: "center", fontFamily: mono, fontSize: 20, letterSpacing: "0.1em", color: C.ink2, opacity: interpolate(f, [tIts, tIts + 12], [0, 1], clamp) }}>
        CHAOS ENGINEERING FOR AI AGENTS
      </div>
      <Sequence from={tIts - 6} layout="none">
        <Browser name="hero" url="usebulwark.vercel.app" width={1000} left={460} top={330} from={45} rate={0.68} />
      </Sequence>
      <div style={{ position: "absolute", left: 120, top: 470, display: "flex", flexDirection: "column", gap: 18, alignItems: "flex-end", width: 310 }}>
        <Pill at={rel("attacks")} bg="#fff" ink={C.ink} style={{ boxShadow: "0 0 0 1px rgba(0,0,0,0.1), 0 10px 30px rgba(0,0,0,0.08)" }}><Tag kind="red" /> attacks first</Pill>
        <Pill at={rel("writes")} bg="#fff" ink={C.ink} style={{ boxShadow: "0 0 0 1px rgba(0,0,0,0.1), 0 10px 30px rgba(0,0,0,0.08)" }}><Tag kind="blue" /> writes the fix</Pill>
      </div>
      <div style={{ position: "absolute", left: 1490, top: 560, display: "flex", flexDirection: "column", gap: 18, width: 320 }}>
        <Pill at={rel("independent")} bg={C.ink}><Tag kind="judge" dark /> proves it</Pill>
        <Pill at={rel("proves")} bg="#fff" ink={C.ink} style={{ boxShadow: "0 0 0 1px rgba(0,0,0,0.1), 0 10px 30px rgba(0,0,0,0.08)" }}>on fresh seeds</Pill>
      </div>
    </AbsoluteFill>
  );
};
