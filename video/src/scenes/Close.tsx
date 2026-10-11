import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { C, inter, mono } from "../theme";
import { clamp, expo, pop, ramp } from "../ui/motion";
import { useRel, PartnerLogo, Cta } from "../ui/kit";
import { Wall } from "../ui/Wall";
import { Words } from "../ui/Words";

// Heights chosen so each official logo sits at roughly 145-170 px wide at 1080p.
const PARTNERS = [
  { id: "neatlogs" as const, h: 36, role: "traces", word: "Agents" },
  { id: "entire" as const, h: 40, role: "provenance", word: "trust" },
  { id: "cfoai" as const, h: 52, role: "business plan", word: "run" },
  { id: "0g" as const, h: 70, role: "models", word: "without" },
  { id: "crustdata" as const, h: 34, role: "data", word: "watching." },
];

/** The wall, whole. Break it first. Built with: the partner logos, one per word. */
export const Close: React.FC = () => {
  const f = useCurrentFrame();
  const rel = useRel("close");
  const tName = rel("Bulwark.");
  const word = interpolate(f, [tName - 4, tName + 14], [0, 1], { ...clamp, easing: expo });
  const tAgents = rel("Agents");
  return (
    <AbsoluteFill style={{ background: C.paper, fontFamily: inter, color: C.ink }}>
      <AbsoluteFill style={{ alignItems: "center", paddingTop: 110 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
          <Wall size={140} build={[-10, tName + 4]} />
          <div style={{ fontSize: 132, fontWeight: 500, letterSpacing: "-0.06em", opacity: word, clipPath: `inset(0 ${(1 - word) * 100}% 0 0)` }}>Bulwark</div>
        </div>
        <div style={{ marginTop: 14, fontSize: 84, fontWeight: 300, letterSpacing: "-0.045em" }}>
          <Words text="Break it first." at={rel("Break")} every={5} accent={{ "first.": C.crash }} serifScale={1.15} />
        </div>
        <div style={{ marginTop: 8, fontSize: 36, fontWeight: 300, letterSpacing: "-0.025em", color: C.ink2 }}>
          <Words text="Agents you can trust to run without you watching." at={tAgents} every={3} />
        </div>
      </AbsoluteFill>

      {/* Built with: the partner logo wall */}
      <div style={{ position: "absolute", left: 0, right: 0, top: 560, display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div style={{ fontFamily: mono, fontSize: 17, letterSpacing: "0.14em", color: C.ink2, opacity: ramp(f, tAgents - 10, tAgents + 4) }}>BUILT DURING #NEATHACK 2026 WITH</div>
        <div style={{ marginTop: 34, display: "flex", alignItems: "stretch", gap: 22 }}>
          {PARTNERS.map((p) => {
            const at = rel(p.word) - 2;
            const q = pop(f, at);
            return (
              <div key={p.id} style={{
                width: 250, height: 170, borderRadius: 24, background: "#fff", boxShadow: "0 0 0 1px rgba(0,0,0,0.08), 0 18px 40px -18px rgba(0,0,0,0.25)",
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20,
                opacity: Math.min(1, q * 1.5), transform: `translateY(${(1 - q) * 30}px) scale(${0.85 + 0.15 * q})`,
              }}>
                <div style={{ height: 72, display: "flex", alignItems: "center" }}><PartnerLogo id={p.id} height={p.h} /></div>
                <div style={{ fontFamily: mono, fontSize: 18, letterSpacing: "0.04em", color: C.ink2 }}>{p.role}</div>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 48, opacity: ramp(f, rel("watching.") + 14, rel("watching.") + 28) }}>
          <Cta>github.com/mrnetwork0001/Bulwark</Cta>
        </div>
      </div>
    </AbsoluteFill>
  );
};
