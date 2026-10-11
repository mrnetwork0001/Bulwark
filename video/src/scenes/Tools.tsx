import React from "react";
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from "remotion";
import { C, inter, mono } from "../theme";
import { clamp, soft, ramp } from "../ui/motion";
import { useRel, PartnerLogo, Terminal, Pill, Kicker } from "../ui/kit";
import { Window, Browser, markOf } from "../ui/Footage";
import { Count } from "../ui/Count";
import data from "../data.json";

const N = data.numbers;

/** neatlogs, Entire, cfo.ai: one panel each, on a track that slides left. */
export const Tools: React.FC = () => {
  const f = useCurrentFrame();
  const rel = useRel("tools");
  const tEntire = rel("Entire");
  const tCfo = rel("And", 1);
  const x = interpolate(f, [tEntire - 18, tEntire, tCfo - 16, tCfo + 2], [0, -1920, -1920, -3840], { ...clamp, easing: soft });
  const tBack = rel("back");
  const cfoSummary = markOf("cfo", "cfo_summary", 105);
  return (
    <AbsoluteFill style={{ background: C.paper, fontFamily: inter, color: C.ink, overflow: "hidden" }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: 1920 * 3, height: 1080, transform: `translateX(${x}px)` }}>
        {/* neatlogs */}
        <div style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 1080 }}>
          <div style={{ position: "absolute", left: 120, top: 110, display: "flex", alignItems: "center", gap: 22 }}>
            <PartnerLogo id="neatlogs" height={46} />
          </div>
          <div style={{ position: "absolute", left: 120, top: 190, width: 560, fontSize: 52, fontWeight: 300, letterSpacing: "-0.035em", lineHeight: 1.12 }}>
            One session per run. One trace per phase.
          </div>
          <div style={{ position: "absolute", left: 120, top: 360, width: 560, fontSize: 26, fontWeight: 300, color: C.ink2, lineHeight: 1.4, opacity: ramp(f, rel("Blue") - 4, rel("Blue") + 10) }}>
            Before Blue writes a fix, it reads the failing trial’s trace back from neatlogs.
          </div>
          <div style={{ position: "absolute", left: 120, top: 520, width: 600, opacity: ramp(f, tBack - 6, tBack + 6), transform: `translateY(${(1 - ramp(f, tBack - 6, tBack + 10)) * 14}px)` }}>
            <div style={{ fontFamily: mono, fontSize: 14, letterSpacing: "0.1em", color: C.ink2, marginBottom: 10 }}>FROM THE LIVE RUN’S TIMELINE</div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 20px", borderRadius: 16, background: "#fff", boxShadow: "0 0 0 1px rgba(0,0,0,0.08), 0 12px 30px rgba(0,0,0,0.06)", fontSize: 21 }}>
              <span style={{ fontFamily: mono, fontSize: 14, fontWeight: 500, letterSpacing: "0.06em", padding: "4px 9px", borderRadius: 6, background: "#6b7280", color: "#fff" }}>OBSERVE</span>
              <span style={{ color: C.pass, fontWeight: 500 }}>read</span>
              <span>neatlogs trace <span style={{ fontFamily: mono, fontSize: 18 }}>e1954fb78c…</span>: 6 spans, given to Blue</span>
            </div>
          </div>
          <div style={{ position: "absolute", left: 120, top: 760, fontFamily: mono, fontSize: 15, color: C.dim, width: 600 }}>
            neatlogs screenshots: the team’s own project, Oct 11
          </div>
          <Window src="neatlogs/sessions.png" url="app.neatlogs.com · sessions" width={1040} left={780} top={120} imgW={2206} imgH={1228} enter={0} push={[1, 1.04]} />
          <div style={{ opacity: ramp(f, rel("one") - 4, rel("one") + 8) }}>
            <Window src="neatlogs/session-open.png" url="a bulwark run: one session, its phase traces" width={1000} left={840} top={680} imgW={2194} imgH={408} enter={rel("one") - 4} push={[1, 1.02]} />
          </div>
        </div>

        {/* Entire */}
        <div style={{ position: "absolute", left: 1920, top: 0, width: 1920, height: 1080 }}>
          <div style={{ position: "absolute", left: 120, top: 110 }}><PartnerLogo id="entire" height={40} /></div>
          <div style={{ position: "absolute", left: 120, top: 190, width: 560, fontSize: 52, fontWeight: 300, letterSpacing: "-0.035em", lineHeight: 1.12 }}>
            Every weak line, traced to the AI session that wrote it.
          </div>
          <div style={{ position: "absolute", left: 120, top: 420, display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-start" }}>
            <Pill at={tEntire + 30} bg={C.ink}>Entire-Checkpoint trailer on every commit</Pill>
            <Pill at={tEntire + 38} bg="#fff" ink={C.ink} style={{ boxShadow: "0 0 0 1px rgba(0,0,0,0.12)" }}>{data.checkpoints} checkpoints pushed</Pill>
            <Pill at={tEntire + 46} bg="#fff" ink={C.ink} style={{ boxShadow: "0 0 0 1px rgba(0,0,0,0.12)" }}>Entire Graph sizes each blast radius</Pill>
          </div>
          <Terminal title="npm run provenance -- targets/refundbot/tools.ts:87" width={1060} style={{ position: "absolute", left: 740, top: 150 }} font={18}
            lines={[
              { t: "targets/refundbot/tools.ts:87", at: tEntire - 10, color: "#fff" },
              ...data.provenance.slice(0, 7).map((t, i) => ({ t: "  " + t, at: tEntire - 4 + i * 4, color: /session|prompt/.test(t) ? "#fff" : undefined })),
            ]} />
          <Terminal title="entire status" width={1060} style={{ position: "absolute", left: 740, top: 640 }} font={18}
            lines={data.entireStatus.slice(0, 2).map((t, i) => ({ t, at: tEntire + 34 + i * 4, color: i === 0 ? "#86EFAC" : undefined }))} />
        </div>

        {/* cfo.ai */}
        <div style={{ position: "absolute", left: 3840, top: 0, width: 1920, height: 1080 }}>
          <div style={{ position: "absolute", left: 120, top: 110 }}><PartnerLogo id="cfoai" height={46} /></div>
          <div style={{ position: "absolute", left: 120, top: 190, width: 560, fontSize: 52, fontWeight: 300, letterSpacing: "-0.035em", lineHeight: 1.12 }}>
            The business plan, built in cfo.ai.
          </div>
          <div style={{ position: "absolute", left: 120, top: 360, width: 600 }}>
            <Kicker at={tCfo + 6}>ARR · years 1 to 3</Kicker>
            <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginTop: 12, fontSize: 58, fontWeight: 300, letterSpacing: "-0.04em" }}>
              {N.arr.map((v, i) => (
                <React.Fragment key={i}>
                  {i ? <span style={{ fontSize: 34, color: C.dim }}>→</span> : null}
                  <span style={{ color: i === 2 ? C.ink : C.ink2 }}><Count to={Math.round(v / 1000)} at={tCfo + 8 + i * 10} dur={24} prefix="$" suffix="k" /></span>
                </React.Fragment>
              ))}
            </div>
            <div style={{ marginTop: 26, display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-start" }}>
              <Pill at={tCfo + 36} bg={C.ink}>cash-flow positive from {N.cashPositive}</Pill>
              <Pill at={tCfo + 44} bg="#fff" ink={C.ink} style={{ boxShadow: "0 0 0 1px rgba(0,0,0,0.12)" }}>from measured run costs</Pill>
              <Pill at={tCfo + 52} bg="#fff" ink={C.ink} style={{ boxShadow: "0 0 0 1px rgba(0,0,0,0.12)" }}>
                <PartnerLogo id="crustdata" height={20} /> {N.agentBuilders.toLocaleString("en-US")} companies building AI agents
              </Pill>
            </div>
          </div>
          <Sequence from={tCfo - 20} layout="none">
            <Browser name="cfo" url="app.cfo.ai/s/xAu-NTAidKxJcCm7 · read-only plan" width={1060} left={760} top={150} from={cfoSummary - 20} rate={1.25} />
          </Sequence>
        </div>
      </div>
    </AbsoluteFill>
  );
};
