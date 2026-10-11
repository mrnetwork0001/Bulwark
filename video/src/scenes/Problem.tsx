import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { C, GRAD, inter, mono } from "../theme";
import { clamp, expo, pop, ramp } from "../ui/motion";
import { useRel, Kicker } from "../ui/kit";
import { Wall, ATTACK_BRICKS } from "../ui/Wall";
import { Words } from "../ui/Words";
import { Count } from "../ui/Count";

/** RefundBot's eight faults (targets/refundbot fault catalog). */
export const FAULTS = [
  "timeout-after-commit", "latency-spike", "malformed-response", "rate-limit",
  "prompt-injection", "stuck-pending", "social-authority", "social-third-party",
];

/** No crash, no failing test, 56%: eight attacks knock eight bricks out of the wall. */
export const Problem: React.FC = () => {
  const f = useCurrentFrame();
  const rel = useRel("problem");
  const tUnder = rel("Under");
  const t56 = rel("fifty-six");
  const tAnd = rel("And");
  // The first brick is already out (the cold open's retry); the rest go during "real-world failures ... rules".
  const knockAt = (k: number) => (k === 0 ? -100 : tUnder + 8 + (k - 1) * 12);
  const knocks = ATTACK_BRICKS.map((i, k) => ({ i, at: knockAt(k) }));
  const lift = interpolate(f, [tAnd - 10, tAnd + 10], [0, -40], { ...clamp, easing: expo });
  return (
    <AbsoluteFill style={{ background: C.paper, fontFamily: inter, color: C.ink }}>
      <div style={{ position: "absolute", left: 140, top: 190, transform: `translateY(${lift}px)` }}>
        <div style={{ fontSize: 132, fontWeight: 300, letterSpacing: "-0.05em", lineHeight: 1.02 }}>
          <div><Words text="No crash." at={rel("No")} every={5} /></div>
          <div style={{ color: C.dim }}><Words text="No failing test." at={rel("No", 1)} every={5} /></div>
        </div>
        {/* 56% */}
        <div style={{ marginTop: 60, opacity: ramp(f, t56 - 30, t56 - 14) }}>
          <Kicker at={t56 - 30}>refundbot · 8 real-world faults · 20 trials each</Kicker>
          <div style={{ display: "flex", alignItems: "baseline", gap: 26, marginTop: 14 }}>
            <div style={{ fontSize: 190, fontWeight: 300, letterSpacing: "-0.06em", lineHeight: 1 }}>
              <Count to={56} at={t56 - 24} dur={28} suffix="%" />
            </div>
            <div style={{ fontSize: 34, fontWeight: 300, letterSpacing: "-0.02em", color: C.ink2, maxWidth: 380, lineHeight: 1.2 }}>of trials keep every business rule</div>
          </div>
          <div style={{ marginTop: 22, width: 760, height: 10, borderRadius: 5, background: C.muted, overflow: "hidden" }}>
            <div style={{ width: `${interpolate(f, [t56 - 24, t56 + 4], [0, 56], { ...clamp, easing: expo })}%`, height: "100%", background: GRAD, backgroundSize: "760px 10px" }} />
          </div>
        </div>
        <div style={{ marginTop: 56, fontSize: 44, fontWeight: 300, letterSpacing: "-0.025em", maxWidth: 900 }}>
          <Words text="Every other approach waits for it to break, then heals it." at={rel("every")} every={3} accent={{ "heals": C.ink }} />
        </div>
      </div>

      {/* The wall, attacked */}
      <div style={{ position: "absolute", left: 1210, top: 170 }}>
        <Wall size={560} knocks={knocks} />
      </div>
      <div style={{ position: "absolute", left: 1250, top: 770, width: 520, display: "flex", flexWrap: "wrap", gap: 10 }}>
        {FAULTS.map((name, k) => {
          const at = k === 0 ? 0 : knockAt(k);
          const p = pop(f, at);
          return (
            <span key={name} style={{ fontFamily: mono, fontSize: 15.5, padding: "7px 13px", borderRadius: 999, background: "rgba(220,38,38,0.08)", color: C.crash, boxShadow: "inset 0 0 0 1px rgba(220,38,38,0.25)", opacity: Math.min(1, p * 1.5), transform: `scale(${0.7 + 0.3 * p})` }}>{name}</span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
