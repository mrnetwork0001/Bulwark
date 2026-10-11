import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, interpolate, staticFile, useCurrentFrame } from "remotion";
import footage from "../footage.json";
import { inter, mono, C } from "../theme";
import { clamp, soft } from "./motion";

export interface Rect { x: number; y: number; w: number; h: number }
export interface Clip { file: string; width: number; height: number; durationFrames: number; marks?: Record<string, number>; rects?: Record<string, Rect> }
const LIB = footage as unknown as Record<string, Clip>;
export const clip = (name: string): Clip | undefined => LIB[name];
export const markOf = (name: string, m: string, fallback = 0) => LIB[name]?.marks?.[m] ?? fallback;
export const rectOf = (name: string, r: string): Rect | undefined => LIB[name]?.rects?.[r];

/** The page the footage was recorded at, in CSS pixels. */
export const PAGE = { w: 1600, h: 900 };

/** A camera keyframe: at frame `at`, frame `rect` (page CSS px) at `zoom` (1 = whole page). */
export interface Cam { at: number; rect?: Rect; zoom?: number }

function camAt(f: number, cams: Cam[]) {
  const full = { cx: PAGE.w / 2, cy: PAGE.h / 2, s: 1 };
  const val = (c: Cam) => (c.rect ? { cx: c.rect.x + c.rect.w / 2, cy: c.rect.y + c.rect.h / 2, s: c.zoom ?? 1.6 } : { ...full, s: c.zoom ?? 1 });
  if (!cams.length) return full;
  if (f <= cams[0].at) return val(cams[0]);
  for (let i = 1; i < cams.length; i++) {
    const a = cams[i - 1], b = cams[i];
    if (f <= b.at) {
      const span = Math.min(b.at - a.at, 36);
      const p = interpolate(f, [b.at - span, b.at], [0, 1], { ...clamp, easing: soft });
      const va = val(a), vb = val(b);
      return { cx: va.cx + (vb.cx - va.cx) * p, cy: va.cy + (vb.cy - va.cy) * p, s: va.s + (vb.s - va.s) * p };
    }
  }
  return val(cams[cams.length - 1]);
}

/**
 * A browser window playing a recorded clip of the real product. `from` is the clip frame
 * shown at this component's frame 0; `cams` moves the camera (each move eases over up to
 * 36 frames ending at its `at`).
 */
export const Browser: React.FC<{
  name: string; url: string; width: number; left: number; top: number;
  from?: number; cams?: Cam[]; still?: string; enter?: number; tilt?: number; dark?: boolean; rate?: number;
  shadow?: boolean; children?: React.ReactNode;
}> = ({ name, url, width, left, top, from = 0, cams = [], still, enter = 0, tilt = 0, dark, rate = 1, shadow = true, children }) => {
  const f = useCurrentFrame();
  const c = clip(name);
  const bar = 44;
  const vh = (width * PAGE.h) / PAGE.w;
  const k = width / PAGE.w;
  const { cx, cy, s } = camAt(f, cams);
  const txFull = width / 2 - cx * k * s;
  const tyFull = vh / 2 - cy * k * s;
  const tx = Math.min(0, Math.max(width - PAGE.w * k * s, txFull));
  const ty = Math.min(0, Math.max(vh - PAGE.h * k * s, tyFull));
  const inP = interpolate(f, [enter, enter + 18], [0, 1], { ...clamp, easing: soft });
  return (
    <div style={{
      position: "absolute", left, top, width, height: vh + bar, borderRadius: 20, overflow: "hidden",
      background: C.paper,
      boxShadow: shadow ? (dark ? "0 0 0 1px rgba(255,255,255,0.14), 0 40px 100px rgba(0,0,0,0.6)" : "0 0 0 1px rgba(0,0,0,0.08), 0 2px 4px rgba(0,0,0,0.04), 0 40px 90px -30px rgba(0,0,0,0.35)") : undefined,
      opacity: inP, transform: `translateY(${(1 - inP) * 40}px) perspective(2400px) rotateX(${tilt * (1 - inP)}deg)`,
    }}>
      <div style={{ height: bar, display: "flex", alignItems: "center", gap: 8, padding: "0 18px", background: "#F4F4F6", borderBottom: "1px solid rgba(0,0,0,0.08)" }}>
        {[0, 1, 2].map((i) => <span key={i} style={{ width: 11, height: 11, borderRadius: 6, background: "rgba(10,10,10,0.16)" }} />)}
        <div style={{ marginLeft: 16, flex: 1, maxWidth: 620, height: 26, borderRadius: 13, background: "#FFFFFF", boxShadow: "0 0 0 1px rgba(0,0,0,0.06)", display: "flex", alignItems: "center", padding: "0 14px", fontFamily: mono, fontSize: 13.5, color: "rgba(10,10,10,0.56)" }}>{url}</div>
      </div>
      <div style={{ position: "relative", width, height: vh, overflow: "hidden", background: C.paper2 }}>
        <div style={{ position: "absolute", left: 0, top: 0, width: PAGE.w, height: PAGE.h, transformOrigin: "0 0", transform: `translate(${tx}px, ${ty}px) scale(${k * s})` }}>
          {c ? (
            <OffthreadVideo src={staticFile(c.file)} startFrom={Math.max(0, Math.round(from))} playbackRate={rate} muted style={{ width: PAGE.w, height: PAGE.h }} />
          ) : still ? (
            <Img src={staticFile(still)} style={{ width: PAGE.w, height: PAGE.h }} />
          ) : (
            <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", fontFamily: inter, color: C.dim, fontSize: 28 }}>footage “{name}” pending</AbsoluteFill>
          )}
        </div>
        {children}
      </div>
    </div>
  );
};

/** A still image (e.g. a real screenshot) in the same window frame, with a slow push-in. */
export const Window: React.FC<{
  src: string; url: string; width: number; left: number; top: number; imgW: number; imgH: number;
  enter?: number; push?: [number, number]; origin?: string; dark?: boolean; crop?: number;
}> = ({ src, url, width, left, top, imgW, imgH, enter = 0, push = [1, 1.06], origin = "50% 30%", dark, crop }) => {
  const f = useCurrentFrame();
  const bar = 44;
  const vh = crop ?? (width * imgH) / imgW;
  const inP = interpolate(f, [enter, enter + 18], [0, 1], { ...clamp, easing: soft });
  const s = interpolate(f, [enter, enter + 150], push, clamp);
  return (
    <div style={{
      position: "absolute", left, top, width, height: vh + bar, borderRadius: 20, overflow: "hidden", background: C.paper,
      boxShadow: dark ? "0 0 0 1px rgba(255,255,255,0.14), 0 40px 100px rgba(0,0,0,0.6)" : "0 0 0 1px rgba(0,0,0,0.08), 0 40px 90px -30px rgba(0,0,0,0.35)",
      opacity: inP, transform: `translateY(${(1 - inP) * 40}px)`,
    }}>
      <div style={{ height: bar, display: "flex", alignItems: "center", gap: 8, padding: "0 18px", background: "#F4F4F6", borderBottom: "1px solid rgba(0,0,0,0.08)" }}>
        {[0, 1, 2].map((i) => <span key={i} style={{ width: 11, height: 11, borderRadius: 6, background: "rgba(10,10,10,0.16)" }} />)}
        <div style={{ marginLeft: 16, flex: 1, maxWidth: 520, height: 26, borderRadius: 13, background: "#FFFFFF", boxShadow: "0 0 0 1px rgba(0,0,0,0.06)", display: "flex", alignItems: "center", padding: "0 14px", fontFamily: mono, fontSize: 13.5, color: "rgba(10,10,10,0.56)" }}>{url}</div>
      </div>
      <div style={{ width, height: vh, overflow: "hidden" }}>
        <Img src={staticFile(src)} style={{ width, height: (width * imgH) / imgW, transform: `scale(${s})`, transformOrigin: origin }} />
      </div>
    </div>
  );
};
