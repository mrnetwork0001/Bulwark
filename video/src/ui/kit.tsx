import React from "react";
import { Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { scene, wordAt } from "../timing";
import { C, inter, mono } from "../theme";
import { clamp, expo, pop } from "./motion";

/** Scene-relative word frames: rel("word", nth). */
export const useRel = (id: string) => {
  const s = scene(id);
  return (w: string, n = 0) => wordAt(id, w, n) - s.from;
};

/** Eyebrow label in the dashboard's manner: a dot and Geist Mono. */
export const Kicker: React.FC<{ children: React.ReactNode; color?: string; dot?: string; style?: React.CSSProperties; at?: number }> = ({ children, color = C.ink2, dot, style, at = 0 }) => {
  const f = useCurrentFrame();
  const p = interpolate(f, [at, at + 14], [0, 1], { ...clamp, easing: expo });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, fontFamily: mono, fontSize: 18, letterSpacing: "0.08em", textTransform: "uppercase", color, opacity: p, transform: `translateY(${(1 - p) * 10}px)`, ...style }}>
      <span style={{ width: 8, height: 8, borderRadius: 4, background: dot ?? color }} />
      {children}
    </div>
  );
};

/** A pill that pops in at `at`. */
export const Pill: React.FC<{ at: number; children: React.ReactNode; bg?: string; ink?: string; style?: React.CSSProperties; big?: boolean }> = ({ at, children, bg = C.ink, ink = "#fff", style, big }) => {
  const f = useCurrentFrame();
  const p = pop(f, at);
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 10, padding: big ? "16px 28px" : "10px 20px", borderRadius: 999, background: bg, color: ink,
      fontFamily: inter, fontWeight: 500, fontSize: big ? 30 : 21, letterSpacing: "-0.01em", whiteSpace: "nowrap",
      transform: `scale(${0.6 + 0.4 * p})`, opacity: Math.min(1, p * 1.4), ...style,
    }}>{children}</span>
  );
};

/** The agent tags from the dashboard timeline (RED / BLUE / JUDGE / GUARD). */
export const Tag: React.FC<{ kind: "red" | "blue" | "judge" | "guard"; dark?: boolean; size?: number }> = ({ kind, dark, size = 16 }) => {
  const bg = { red: C.crash, blue: C.blue, judge: dark ? "#fff" : C.ink, guard: C.guard }[kind];
  const ink = kind === "judge" && dark ? C.ink : "#fff";
  return <span style={{ fontFamily: mono, fontWeight: 500, fontSize: size, letterSpacing: "0.06em", padding: "4px 9px", borderRadius: 6, background: bg, color: ink }}>{kind.toUpperCase()}</span>;
};

/** The dashboard's black pill CTA with a round arrow. */
export const Cta: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 18, padding: "12px 12px 12px 30px", borderRadius: 999, background: C.ink, color: "#fff", fontFamily: inter, fontWeight: 500, fontSize: 26, ...style }}>
    {children}
    <span style={{ width: 46, height: 46, borderRadius: 23, background: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
      <svg width="20" height="20" viewBox="0 0 16 16"><path d="M4.5 11.5l7-7M6 4.5h5.5V10" stroke={C.ink} strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </span>
  </span>
);

/** Official partner logos (video/public/logos, sources in README). */
export const PartnerLogo: React.FC<{ id: "neatlogs" | "entire" | "cfoai" | "0g" | "crustdata"; height: number; color?: string; style?: React.CSSProperties }> = ({ id, height, color = C.ink, style }) => {
  if (id === "neatlogs") {
    // The wordmark ships as an alpha mask (neatlogs.com/brand/neatlogs-wordmark.webp), tinted like their site does.
    return <span style={{ display: "inline-block", height, aspectRatio: "5772 / 1276", background: color, WebkitMaskImage: `url(${staticFile("logos/neatlogs-wordmark.webp")})`, maskImage: `url(${staticFile("logos/neatlogs-wordmark.webp")})`, WebkitMaskSize: "100% 100%", maskSize: "100% 100%", ...style }} />;
  }
  const file = { entire: "entire.svg", cfoai: "cfoai.svg", "0g": "0g.svg", crustdata: "crustdata.svg" }[id];
  // Crustdata's wordmark is drawn white (for its dark site); render it monochrome like the rest.
  const invert = id === "crustdata" ? (color === C.ink ? "brightness(0)" : "brightness(0) invert(1)") : color !== C.ink ? "invert(1)" : undefined;
  return <Img src={staticFile(`logos/${file}`)} style={{ height, width: "auto", filter: invert, ...style }} />;
};

/** A dark terminal card holding real command output. */
export const Terminal: React.FC<{ title: string; lines: { t: string; at: number; color?: string }[]; width: number; style?: React.CSSProperties; font?: number }> = ({ title, lines, width, style, font = 19 }) => {
  const f = useCurrentFrame();
  return (
    <div style={{ width, borderRadius: 20, background: "#0E0E0E", boxShadow: "0 0 0 1px rgba(255,255,255,0.1), 0 40px 90px -20px rgba(0,0,0,0.5)", overflow: "hidden", ...style }}>
      <div style={{ height: 42, display: "flex", alignItems: "center", gap: 8, padding: "0 18px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        {[0, 1, 2].map((i) => <span key={i} style={{ width: 11, height: 11, borderRadius: 6, background: "rgba(255,255,255,0.18)" }} />)}
        <span style={{ marginLeft: 12, fontFamily: mono, fontSize: 14, color: "rgba(255,255,255,0.5)" }}>{title}</span>
      </div>
      <div style={{ padding: "18px 24px 22px", fontFamily: mono, fontSize: font, lineHeight: 1.6, color: "rgba(255,255,255,0.88)", whiteSpace: "pre" }}>
        {lines.map((l, i) => {
          const p = interpolate(f, [l.at, l.at + 6], [0, 1], clamp);
          return <div key={i} style={{ opacity: p, color: l.color, overflow: "hidden", textOverflow: "ellipsis" }}>{l.t}</div>;
        })}
      </div>
    </div>
  );
};
