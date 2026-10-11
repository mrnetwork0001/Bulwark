import React from "react";
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from "remotion";
import { C, inter, mono } from "../theme";
import { clamp, expo, pop, ramp } from "../ui/motion";
import { useRel, Tag, Pill } from "../ui/kit";
import { Browser, markOf, rectOf } from "../ui/Footage";
import { Wall, ATTACK_BRICKS } from "../ui/Wall";
import { TL_LOW } from "./Fix";

/** Rejected again, then 59/59 on fresh seeds; then the same seed before vs after (Compare with fix). */
export const Prove: React.FC = () => {
  const f = useCurrentFrame();
  const rel = useRel("prove");
  const rejected = markOf("loop", "loop_rejected", 1371);
  const fixed = markOf("loop", "loop_fixed", 1681);
  const tPasses = rel("passes");
  const start = rejected + 24;
  const rate = (fixed - start) / (tPasses + 8);
  const tSame = rel("Same");
  const tGone = rel("gone.");
  const diffAt = markOf("replay", "replay_diff", 330);
  const scrollAt = markOf("replay", "replay_scroll", 475);
  // Part B: the diff view, timed so the scroll to step 13 lands as "second refund" is said.
  const bStart = tSame - 14;
  const bFrom = Math.max(diffAt + 10, scrollAt - (rel("second") - bStart) + 20);
  const diff = rectOf("replay", "diff") ?? { x: 368, y: 178, w: 864, h: 670 };
  const brick = ATTACK_BRICKS[0];
  const n59 = pop(f, rel("fifty-nine"));
  const partA = interpolate(f, [bStart - 8, bStart + 6], [1, 0], clamp);
  return (
    <AbsoluteFill style={{ background: C.night, fontFamily: inter, color: "#fff" }}>
      <AbsoluteFill style={{ background: "radial-gradient(50% 60% at 35% 50%, rgba(255,255,255,0.07), transparent 70%)" }} />
      <Sequence durationInFrames={bStart + 8} layout="none">
        <div style={{ opacity: partA }}>
          <div style={{ position: "absolute", left: 90, top: 90, display: "flex", alignItems: "center", gap: 14, fontFamily: mono, fontSize: 18, letterSpacing: "0.08em", color: "rgba(255,255,255,0.6)" }}>
            <Tag kind="judge" dark /> SLO 95% · EXACT CLOPPER-PEARSON · 59 ZERO-FAILURE TRIALS
          </div>
          <Browser name="loop" url="localhost:5410/app" width={1180} left={90} top={150} from={start} rate={rate} dark cams={[{ at: 0, rect: TL_LOW, zoom: 1.7 }]} />
          <div style={{ position: "absolute", left: 1390, top: 170 }}>
            <Wall size={360} ink="rgba(255,255,255,0.92)" bg={C.night} knocks={ATTACK_BRICKS.map((i) => ({ i, at: -300 }))}
              wobbles={[{ i: brick, at: rel("idempotency"), fall: rel("Rejected") + 2 }]} fixes={[{ i: brick, at: tPasses + 4 }]} />
          </div>
          <div style={{ position: "absolute", left: 1370, top: 560, width: 470, fontFamily: mono, fontSize: 18, lineHeight: 1.7, color: "rgba(255,255,255,0.7)" }}>
            <div style={{ opacity: ramp(f, rel("next"), rel("next") + 10) }}>attempt 2 · idempotency key</div>
            <div style={{ opacity: ramp(f, rel("three"), rel("three") + 10), color: "#FCA5A5" }}>3/59 tickets get no reply · rejected</div>
            <div style={{ opacity: ramp(f, rel("third"), rel("third") + 10), marginTop: 8 }}>attempt 3 · idempotency key + escalate</div>
          </div>
          <div style={{ position: "absolute", left: 1370, top: 700, opacity: Math.min(1, n59 * 1.4), transform: `scale(${0.8 + 0.2 * n59})`, transformOrigin: "left center" }}>
            <div style={{ fontSize: 150, fontWeight: 300, letterSpacing: "-0.05em", lineHeight: 1, color: C.g2 }}>59<span style={{ color: "rgba(255,255,255,0.45)" }}>/59</span></div>
            <div style={{ fontFamily: mono, fontSize: 18, color: "rgba(255,255,255,0.7)", marginTop: 8 }}>passed on fresh seeds</div>
          </div>
          <div style={{ position: "absolute", left: 1370, top: 905 }}>
            <Pill at={rel("ninety-five")} bg={C.g2} ink={C.ink}>SLO ≥ 95% demonstrated</Pill>
          </div>
        </div>
      </Sequence>

      {/* Same seed, before vs after */}
      <Sequence from={bStart} layout="none">
        <div style={{ position: "absolute", left: 90, top: 90, display: "flex", alignItems: "center", gap: 14, fontFamily: mono, fontSize: 18, letterSpacing: "0.08em", color: "rgba(255,255,255,0.6)", opacity: ramp(f - bStart, 0, 12) }}>
          TRIAL REPLAY · SEED 1286473109 · COMPARE WITH FIX
        </div>
        <Browser name="replay" url="localhost:5410/app · trial replay" width={1500} left={210} top={150} from={bFrom} dark enter={0}
          cams={[{ at: 0, rect: { x: diff.x, y: diff.y + 20, w: diff.w, h: 360 }, zoom: 1.45 }, { at: 40, rect: { x: diff.x, y: diff.y + 230, w: diff.w, h: 440 }, zoom: 1.6 }]} />
      </Sequence>
      <div style={{ position: "absolute", right: 120, top: 84, opacity: ramp(f, tGone - 6, tGone + 6), transform: `scale(${0.85 + 0.15 * pop(f, tGone - 6)})` }}>
        <Pill at={tGone - 6} bg={C.g2} ink={C.ink} big>rf_2 never happens</Pill>
      </div>
    </AbsoluteFill>
  );
};
