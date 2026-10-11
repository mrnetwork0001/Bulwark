import React from "react";
import { AbsoluteFill } from "remotion";
import { C, inter, mono, serif } from "./theme";
import { Wall, ATTACK_BRICKS } from "./ui/Wall";

/** Thumbnail: the wall mid-repair on alarm red, the name, the line. */
export const Poster: React.FC = () => (
  <AbsoluteFill style={{ background: C.paper, fontFamily: inter, color: C.ink }}>
    <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 760, background: C.alarm }} />
    <div style={{ position: "absolute", right: 110, top: 250 }}>
      <Wall size={540} ink="#fff" bg={C.alarm} slotColor="#fff"
        knocks={ATTACK_BRICKS.map((i) => ({ i, at: -300 }))} fixes={ATTACK_BRICKS.slice(0, 5).map((i) => ({ i, at: -200 }))} />
    </div>
    <div style={{ position: "absolute", left: 120, top: 230 }}>
      <div style={{ fontFamily: mono, fontSize: 22, letterSpacing: "0.12em", color: C.ink2 }}>CHAOS ENGINEERING FOR AI AGENTS</div>
      <div style={{ marginTop: 20, fontSize: 210, fontWeight: 500, letterSpacing: "-0.06em", lineHeight: 1 }}>Bulwark</div>
      <div style={{ marginTop: 26, fontSize: 96, fontWeight: 300, letterSpacing: "-0.045em" }}>
        Break it <span style={{ fontFamily: serif, fontStyle: "italic", color: C.crash, fontSize: "1.15em" }}>first.</span>
      </div>
      <div style={{ marginTop: 40, fontSize: 44, fontWeight: 300, letterSpacing: "-0.02em" }}>
        56% <span style={{ color: C.dim }}>→</span> <span style={{ color: C.pass }}>100%</span>
        <span style={{ fontSize: 24, color: C.ink2, marginLeft: 18 }}>of trials keep every business rule</span>
      </div>
      <div style={{ marginTop: 60, fontFamily: mono, fontSize: 20, color: C.ink2 }}>#neatHack 2026 · neatlogs · Entire · cfo.ai</div>
    </div>
  </AbsoluteFill>
);
