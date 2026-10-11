import React from "react";
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from "remotion";
import { C, inter, mono } from "../theme";
import { clamp, expo, ramp } from "../ui/motion";
import { useRel, Pill } from "../ui/kit";
import { Wall, ATTACK_BRICKS } from "../ui/Wall";
import { Browser, markOf, rectOf } from "../ui/Footage";
import data from "../data.json";

const N = data.numbers;

/** Full-bleed alarm red; at "one hundred" it turns green and the wall closes. */
export const Result: React.FC = () => {
  const f = useCurrentFrame();
  const rel = useRel("result");
  const tHundred = rel("one");
  const green = ramp(f, tHundred - 2, tHundred + 14);
  const pct = Math.round(interpolate(f, [rel("to") - 4, tHundred + 6], [N.refundbot[0], N.refundbot[1]], { ...clamp, easing: expo }));
  const tFive = rel("Five");
  const tZero = rel("zero.");
  const risk = Math.round(interpolate(f, [tFive, tZero + 4], [N.atRisk[0], N.atRisk[1]], { ...clamp, easing: expo }));
  const riskOn = ramp(f, tFive - 8, tFive + 6);
  const tPull = rel("pull");
  // Every knocked brick drops back in, green, as the number reaches 100.
  const fixes = ATTACK_BRICKS.map((i, k) => ({ i, at: tHundred - 6 + k * 3 }));
  const results = rectOf("loop", "results") ?? { x: 988, y: 176, w: 552, h: 721 };
  const resultFrame = markOf("loop", "loop_result", 3480);
  const card = ramp(f, tPull - 10, tPull + 8);
  return (
    <AbsoluteFill style={{ background: C.alarm, fontFamily: inter, color: "#fff" }}>
      <AbsoluteFill style={{ background: C.proof, opacity: green }} />
      <AbsoluteFill style={{ background: "radial-gradient(60% 70% at 30% 40%, rgba(255,255,255,0.14), transparent 70%)" }} />
      <div style={{ position: "absolute", left: 130, top: 120, fontFamily: mono, fontSize: 18, letterSpacing: "0.1em", color: "rgba(255,255,255,0.75)" }}>
        REFUNDBOT · TRIALS THAT KEEP EVERY BUSINESS RULE · BEFORE → AFTER
      </div>
      <div style={{ position: "absolute", left: 120, top: 150, fontSize: 330, fontWeight: 300, letterSpacing: "-0.065em", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
        {pct}<span style={{ fontSize: 160 }}>%</span>
      </div>
      {/* the resilience bar: red → amber → green */}
      <div style={{ position: "absolute", left: 130, top: 520, width: 900, height: 12, borderRadius: 6, background: "rgba(255,255,255,0.22)", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: `linear-gradient(90deg, ${C.g0}, ${C.g1} 45%, ${C.g2})`, backgroundSize: "900px 12px", boxShadow: "0 0 0 1px rgba(255,255,255,0.5)" }} />
      </div>
      <div style={{ position: "absolute", left: 130, top: 590, opacity: riskOn, transform: `translateY(${(1 - riskOn) * 16}px)` }}>
        <div style={{ fontSize: 110, fontWeight: 300, letterSpacing: "-0.05em", fontVariantNumeric: "tabular-nums" }}>${risk.toLocaleString("en-US")}</div>
        <div style={{ fontFamily: mono, fontSize: 19, color: "rgba(255,255,255,0.8)", marginTop: 4 }}>at risk per 1,000 tickets · was ${N.atRisk[0].toLocaleString("en-US")} · stated assumptions</div>
      </div>
      <div style={{ position: "absolute", left: 130, top: 830, display: "flex", gap: 14 }}>
        <Pill at={tZero + 6} bg="rgba(255,255,255,0.16)" style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.4)" }}>{N.attempts} attempts</Pill>
        <Pill at={tZero + 10} bg="rgba(255,255,255,0.16)" style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.4)" }}>{N.rejected} rejected and rolled back</Pill>
        <Pill at={tZero + 14} bg="#fff" ink={C.ink}>Fisher p &lt; 10⁻⁶</Pill>
      </div>
      {/* The wall closes */}
      <div style={{ position: "absolute", left: 1230, top: 140, opacity: 1 - card * 0.85, transform: `scale(${1 - 0.25 * card}) translateY(${-60 * card}px)`, transformOrigin: "50% 0%" }}>
        <Wall size={560} ink="#fff" bg={green > 0.5 ? C.proof : C.alarm} slotColor="#fff"
          knocks={ATTACK_BRICKS.map((i) => ({ i, at: -300 }))} fixes={fixes} settle={tHundred + 40} />
      </div>
      {/* The real Result card from the run */}
      <div style={{ opacity: card }}>
        <Sequence from={tPull - 12} layout="none">
          <Browser name="loop" url="localhost:5410/app · result" width={720} left={1120} top={300} from={resultFrame + 10}
            cams={[{ at: 0, rect: { x: results.x, y: results.y, w: results.w, h: 330 }, zoom: 1.75 }]} />
        </Sequence>
        <div style={{ position: "absolute", left: 1130, top: 790, display: "flex", gap: 10, flexWrap: "wrap", width: 700 }}>
          {["PR description", "fix.patch", "postmortems", "regression tests, proven"].map((t, k) => (
            <Pill key={t} at={rel("request,") + k * 5} bg="#fff" ink={C.ink} style={{ fontSize: 18 }}>{t}</Pill>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};
