import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame } from "remotion";
import { C, inter, mono } from "../theme";
import { pop, ramp } from "../ui/motion";
import { useRel, PartnerLogo } from "../ui/kit";
import { Browser, markOf } from "../ui/Footage";
import { Wall } from "../ui/Wall";
import { Count } from "../ui/Count";
import { Words } from "../ui/Words";
import data from "../data.json";

const N = data.numbers;

const Card: React.FC<{ at: number; left: number; children: React.ReactNode; accent?: boolean }> = ({ at, left, children, accent }) => {
  const f = useCurrentFrame();
  const p = pop(f, at);
  return (
    <div style={{
      position: "absolute", left, top: 300, width: 540, height: 560, borderRadius: 28, padding: "34px 36px",
      background: accent ? "#fff" : "#141414", color: accent ? C.ink : "#fff",
      boxShadow: accent ? "0 30px 80px rgba(0,0,0,0.5)" : "0 0 0 1px rgba(255,255,255,0.12)",
      opacity: Math.min(1, p * 1.5), transform: `translateY(${(1 - p) * 40}px) scale(${0.94 + 0.06 * p})`,
    }}>{children}</div>
  );
};
const Label: React.FC<{ children: React.ReactNode; dark?: boolean }> = ({ children, dark }) => (
  <div style={{ fontFamily: mono, fontSize: 15, letterSpacing: "0.1em", color: dark ? C.ink2 : "rgba(255,255,255,0.55)", textTransform: "uppercase" }}>{children}</div>
);
const Big: React.FC<{ from: number; to: number; at: number; dark?: boolean }> = ({ from, to, at, dark }) => (
  <div style={{ display: "flex", alignItems: "baseline", gap: 12, fontSize: 80, fontWeight: 300, letterSpacing: "-0.055em", lineHeight: 1 }}>
    <span style={{ color: dark ? C.dim : "rgba(255,255,255,0.45)" }}>{from}%</span>
    <span style={{ fontSize: 48, color: dark ? C.dim : "rgba(255,255,255,0.45)" }}>→</span>
    <span style={{ color: C.g2 }}><Count from={from} to={to} at={at} dur={24} suffix="%" /></span>
  </div>
);

/** Not tied to one agent; several faults at once; Bulwark attacks itself. */
export const Different: React.FC = () => {
  const f = useCurrentFrame();
  const rel = useRel("different");
  const t1 = 8; // first card in with "It isn't tied to one agent", so the cut never sits on an empty frame
  const t2 = rel("Several");
  const t3 = rel("Bulwark");
  const click = markOf("target", "target_click", 67);
  const selfKnock = [2, 10, 16, 24, 30, 34];
  return (
    <AbsoluteFill style={{ background: C.night, fontFamily: inter, color: "#fff" }}>
      <div style={{ position: "absolute", left: 120, top: 110, fontSize: 76, fontWeight: 300, letterSpacing: "-0.045em" }}>
        <Words text="Any agent. Many faults. Even itself." at={-14} every={3} accent={{ "itself.": "#fff" }} />
      </div>
      <div style={{ position: "absolute", right: 120, top: 136, fontFamily: mono, fontSize: 17, color: "rgba(255,255,255,0.55)", opacity: ramp(f, 6, 20), textAlign: "right" }}>
        {N.tests} tests · every trial replays from its seed
      </div>

      <Card at={t1} left={120}>
        <Label>second target · company briefs</Label>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 12, fontSize: 34, fontWeight: 400, letterSpacing: "-0.02em" }}>
          ResearchBot <span style={{ fontSize: 20, color: "rgba(255,255,255,0.5)" }}>on</span> <PartnerLogo id="crustdata" height={28} color="#fff" style={{ filter: "brightness(0) invert(1)" }} />
        </div>
        <Sequence from={t1} layout="none">
          <Browser name="target" url="usebulwark.vercel.app/app" width={468} left={36} top={140} from={Math.max(0, click - 30)} dark shadow
            cams={[{ at: 0, rect: { x: 900, y: 0, w: 700, h: 400 }, zoom: 1.9 }, { at: 70, rect: { x: 900, y: 0, w: 700, h: 400 }, zoom: 1.9 }, { at: 110 }]} />
        </Sequence>
        <div style={{ position: "absolute", left: 36, bottom: 36 }}>
          <Label>real Crustdata data, recorded once, replayed</Label>
          <div style={{ marginTop: 10 }}><Big from={N.researchbot[0]} to={N.researchbot[1]} at={rel("forty-nine") - 4} /></div>
        </div>
      </Card>

      <Card at={t2 - 6} left={690}>
        <Label>game day · several faults in one trial</Label>
        <div style={{ marginTop: 14, fontSize: 34, letterSpacing: "-0.02em", lineHeight: 1.2 }}>Every fix passed alone. Together, they ran out of time.</div>
        <div style={{ marginTop: 18, fontSize: 21, color: "rgba(255,255,255,0.6)", lineHeight: 1.45 }}>
          Stacked per-call timeouts ran past the 5 second deadline. Single-fault testing missed it. A per-run time budget fixed it.
        </div>
        <div style={{ position: "absolute", left: 36, bottom: 36 }}>
          <Label>refundbot · 16 attacks</Label>
          <div style={{ marginTop: 10 }}><Big from={N.gameDay[0]} to={N.gameDay[1]} at={rel("forty-three") + 10} /></div>
        </div>
      </Card>

      <Card at={t3 - 8} left={1260} accent>
        <Label dark>self-chaos · npm run self-chaos</Label>
        <div style={{ marginTop: 14, fontSize: 34, letterSpacing: "-0.02em" }}>Bulwark attacks itself.</div>
        <div style={{ position: "absolute", right: 36, top: 140 }}>
          <Wall size={170} knocks={selfKnock.map((i, k) => ({ i, at: t3 - 4 + k * 4 }))} fixes={selfKnock.map((i, k) => ({ i, at: rel("eleven") + k * 3 }))} settle={rel("recovered.") + 14} />
        </div>
        <div style={{ marginTop: 22, display: "flex", flexWrap: "wrap", gap: 8, width: 290 }}>
          {data.selfChaos.seams.map((s, k) => (
            <span key={s} style={{ fontFamily: mono, fontSize: 14, padding: "5px 11px", borderRadius: 999, background: C.muted, opacity: ramp(f, t3 + k * 3, t3 + 6 + k * 3) }}>{s}</span>
          ))}
        </div>
        <div style={{ position: "absolute", left: 36, bottom: 36 }}>
          <Label dark>faults injected into its own dependencies</Label>
          <div style={{ display: "flex", alignItems: "baseline", gap: 18, marginTop: 10, fontSize: 96, fontWeight: 300, letterSpacing: "-0.055em", lineHeight: 1 }}>
            <span style={{ opacity: ramp(f, rel("eleven") - 5, rel("eleven")) }}><Count to={data.selfChaos.recovered} at={rel("eleven") - 4} dur={18} /><span style={{ color: C.dim }}>/{data.selfChaos.injected}</span></span>
            <span style={{ fontSize: 22, letterSpacing: 0, color: C.ink2, lineHeight: 1.3 }}>recovered<br />{data.selfChaos.bugsFixed} real bugs fixed</span>
          </div>
        </div>
      </Card>
    </AbsoluteFill>
  );
};
