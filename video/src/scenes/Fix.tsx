import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { C, inter, mono } from "../theme";
import { clamp, expo, ramp } from "../ui/motion";
import { useRel, Tag } from "../ui/kit";
import { Browser, markOf } from "../ui/Footage";
import { Wall, ATTACK_BRICKS } from "../ui/Wall";

export const TL_LOW = { x: 60, y: 430, w: 912, h: 440 };

/** Blue's first fix, the Judge's fresh seeds, REJECTED, rolled back: live footage plus the wall. */
export const Fix: React.FC = () => {
  const f = useCurrentFrame();
  const rel = useRel("fix");
  const blue1 = markOf("loop", "loop_blue1", 1220);
  const rejected = markOf("loop", "loop_rejected", 1371);
  const tRej = rel("Rejected.");
  const start = blue1 - 24;
  const rate = (rejected - start) / (tRej - 6);
  const tFix = rel("fix", 1);
  const stamp = interpolate(f, [tRej - 2, tRej + 6], [2, 1], { ...clamp, easing: expo });
  const stampOp = interpolate(f, [tRej - 2, tRej + 3], [0, 1], clamp);
  const tRolled = rel("Rolled");
  const brick = ATTACK_BRICKS[0];
  return (
    <AbsoluteFill style={{ background: C.night, fontFamily: inter, color: "#fff" }}>
      <AbsoluteFill style={{ background: "radial-gradient(50% 60% at 35% 50%, rgba(255,255,255,0.07), transparent 70%)" }} />
      <div style={{ position: "absolute", left: 90, top: 90, display: "flex", alignItems: "center", gap: 14, fontFamily: mono, fontSize: 18, letterSpacing: "0.08em", color: "rgba(255,255,255,0.6)", opacity: ramp(f, 0, 14) }}>
        <Tag kind="blue" /> WRITES A FIX <span style={{ opacity: 0.4 }}>→</span> <Tag kind="judge" dark /> RE-RUNS EVERY ATTACK ON SEEDS BLUE NEVER SAW
      </div>
      <Browser name="loop" url="usebulwark.vercel.app/app" width={1180} left={90} top={150} from={start} rate={rate} dark
        cams={[{ at: 0, rect: TL_LOW, zoom: 1.7 }]} />
      {/* The wall: the fix drops a brick in, it wobbles, it falls back out */}
      <div style={{ position: "absolute", left: 1390, top: 210 }}>
        <Wall size={420} ink="rgba(255,255,255,0.92)" bg={C.night} knocks={ATTACK_BRICKS.map((i) => ({ i, at: -300 }))} wobbles={[{ i: brick, at: tFix, fall: tRej + 2 }]} />
      </div>
      <div style={{ position: "absolute", left: 1370, top: 660, width: 460, fontFamily: mono, fontSize: 18, color: "rgba(255,255,255,0.7)", lineHeight: 1.6, opacity: ramp(f, rel("first"), rel("first") + 10) }}>
        attempt 1 · retry-backoff<br />
        <span style={{ color: "#FCA5A5" }}>29/59 still refund twice</span>
      </div>
      <div style={{ position: "absolute", left: 1365, top: 760, opacity: stampOp, transform: `scale(${stamp}) rotate(-5deg)`, transformOrigin: "left center" }}>
        <div style={{ border: `5px solid ${C.g0}`, color: C.g0, fontFamily: mono, fontWeight: 500, fontSize: 46, letterSpacing: "0.14em", padding: "8px 22px", borderRadius: 10 }}>REJECTED</div>
      </div>
      <div style={{ position: "absolute", left: 1370, top: 870, fontFamily: mono, fontSize: 22, color: "#fff", opacity: ramp(f, tRolled - 2, tRolled + 10), padding: "8px 18px", borderRadius: 999, background: "rgba(220,38,38,0.25)", boxShadow: "inset 0 0 0 1px rgba(239,68,68,0.5)" }}>
        ↺ rolled back to ckpt-001
      </div>
    </AbsoluteFill>
  );
};
