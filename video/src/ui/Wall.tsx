import React from "react";
import { interpolate, random, useCurrentFrame, Easing } from "remotion";
import { C } from "../theme";
import { clamp, expo } from "./motion";

/**
 * The film's motif: Bulwark's logo (the crenellated wall, `M2 24V5h5v5h4V5h4v5h4V5h5v19z`
 * with a door arch) built from bricks. Each brick can be:
 *   built   dropped in, bottom row first (`build`)
 *   knocked an attack hits it: it flashes alarm red and flies out, leaving a red slot
 *   fixed   a fix the Judge accepted drops it back in, green, with a lock tick
 *   wobble  a rejected fix: it drops in, wobbles, and falls back out (the rollback)
 * Coordinates are in logo units (viewBox 0 0 26 26).
 */
export interface Brick { i: number; x: number; y: number; w: number; h: number; row: number }

const MERLONS: [number, number][] = [[2, 7], [11, 15], [19, 24]];
const ROWS: [number, number][] = [
  [5, 7.5], [7.5, 10], // merlons
  [10, 12.8], [12.8, 15.6], [15.6, 18.4], [18.4, 21.2], [21.2, 24], // body
];

export const BRICKS: Brick[] = (() => {
  const out: Brick[] = [];
  ROWS.forEach(([y0, y1], row) => {
    const pieces: [number, number][] = [];
    if (row < 2) {
      for (const [a, b] of MERLONS) {
        if (row === 0) pieces.push([a, b]);
        else { const m = (a + b) / 2; pieces.push([a, m], [m, b]); }
      }
    } else {
      const off = row % 2 ? 0 : 2;
      for (let x = 2 - off; x < 24; x += 4) {
        const a = Math.max(2, x), b = Math.min(24, x + 4);
        if (b - a > 0.5) pieces.push([a, b]);
      }
    }
    for (const [a, b] of pieces) out.push({ i: out.length, x: a, y: y0, w: b - a, h: y1 - y0, row });
  });
  return out;
})();

/** Brick indices spread across the wall, for the eight attacks. */
export const ATTACK_BRICKS = [9, 3, 15, 22, 12, 27, 18, 6];

export type Event = { i: number; at: number };
export const Wall: React.FC<{
  size: number;
  ink?: string;
  bg?: string;
  build?: [number, number]; // frames: first brick lands .. last brick lands
  knocks?: Event[];
  fixes?: Event[];
  wobbles?: (Event & { fall: number })[];
  settle?: number; // frame at which green fixes settle back into ink
  slotColor?: string;
  door?: boolean;
  style?: React.CSSProperties;
}> = ({ size, ink = C.ink, bg = C.paper, build, knocks = [], fixes = [], wobbles = [], settle, slotColor = C.alarm, door = true, style }) => {
  const f = useCurrentFrame();
  const order = [...BRICKS].sort((a, b) => b.row - a.row || a.x - b.x);
  const rank = new Map(order.map((b, k) => [b.i, k]));
  const gap = 0.16;
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" style={{ overflow: "visible", ...style }}>
      {BRICKS.map((b) => {
        const k = knocks.filter((e) => e.i === b.i).sort((x, y) => y.at - x.at).find((e) => e.at <= f);
        const fx = fixes.filter((e) => e.i === b.i).sort((x, y) => y.at - x.at).find((e) => e.at <= f + 14);
        const wb = wobbles.find((e) => e.i === b.i && e.at <= f + 14 && f < e.fall + 30);
        // Build-in
        let ty = 0, op = 1, rot = 0, tx = 0, fill = ink, stroke: string | undefined, dash: string | undefined;
        if (build) {
          const n = BRICKS.length;
          const t = build[0] + ((build[1] - build[0]) * (rank.get(b.i) ?? 0)) / (n - 1);
          const p = interpolate(f, [t - 10, t], [0, 1], { ...clamp, easing: Easing.bezier(0.3, 0, 0.4, 1.35) });
          ty = (1 - p) * -6;
          op = interpolate(f, [t - 10, t - 6], [0, 1], clamp);
        }
        const knockedAt = k && (!fx || fx.at < k.at) ? k.at : null;
        if (knockedAt != null) {
          const t = f - knockedAt;
          const side = random(`s${b.i}`) > 0.5 ? 1 : -1;
          // flash red, then fly out
          fill = C.alarm;
          const fly = interpolate(t, [4, 26], [0, 1], { ...clamp, easing: Easing.in(Easing.quad) });
          tx += side * fly * 7;
          ty += fly * 14 - Math.sin(fly * Math.PI) * 3;
          rot = side * fly * 70;
          op *= 1 - interpolate(t, [16, 26], [0, 1], clamp);
        }
        // Fixed: drop back in, green
        let lock = 0;
        if (fx && (!k || fx.at >= k.at)) {
          const t = f - fx.at;
          const p = interpolate(t, [-14, 0], [0, 1], { ...clamp, easing: Easing.bezier(0.3, 0, 0.4, 1.4) });
          ty = (1 - p) * -8;
          op = interpolate(t, [-14, -10], [0, 1], clamp);
          tx = 0; rot = 0;
          const g = settle != null ? interpolate(f, [settle, settle + 24], [1, 0], clamp) : 1;
          fill = g > 0.5 ? C.g2 : ink;
          lock = interpolate(t, [0, 6, 24], [0, 1, 0], clamp) * (g > 0.5 ? 1 : 0);
        }
        // Wobble and fall (a rejected fix)
        if (wb) {
          const t = f - wb.at;
          const p = interpolate(t, [-14, 0], [0, 1], { ...clamp, easing: Easing.bezier(0.3, 0, 0.4, 1.3) });
          ty = (1 - p) * -8; tx = 0;
          op = interpolate(t, [-14, -10], [0, 1], clamp);
          fill = C.g1;
          const shake = t > 0 && f < wb.fall ? Math.sin(t * 1.3) * interpolate(t, [0, 6], [0, 9], clamp) : 0;
          rot = shake;
          if (f >= wb.fall) {
            const q = interpolate(f - wb.fall, [0, 22], [0, 1], { ...clamp, easing: Easing.in(Easing.quad) });
            fill = C.alarm;
            ty += q * 16; rot = 25 * q; tx = q * 2;
            op *= 1 - interpolate(f - wb.fall, [12, 22], [0, 1], clamp);
          }
        }
        const slot = (knockedAt != null && !(fx && fx.at >= (k?.at ?? 0))) || (wb && f >= wb.at - 14) ? 1 : 0;
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        return (
          <g key={b.i}>
            {slot ? (
              <rect x={b.x + gap} y={b.y + gap} width={b.w - 2 * gap} height={b.h - 2 * gap} rx={0.3}
                fill="none" stroke={slotColor} strokeWidth={0.14} strokeDasharray="0.45 0.3" opacity={0.75} />
            ) : null}
            <g transform={`translate(${tx} ${ty}) rotate(${rot} ${cx} ${cy})`} opacity={op}>
              <rect x={b.x + gap} y={b.y + gap} width={b.w - 2 * gap} height={b.h - 2 * gap} rx={0.3} fill={fill} stroke={stroke} strokeDasharray={dash} />
              {lock > 0 ? (
                <rect x={b.x - 0.3} y={b.y - 0.3} width={b.w + 0.6} height={b.h + 0.6} rx={0.5} fill="none" stroke={C.g2} strokeWidth={0.18} opacity={lock} />
              ) : null}
            </g>
          </g>
        );
      })}
      {door ? <path d="M11.5 24v-4.5a1.5 1.5 0 0 1 3 0V24z" fill={bg} /> : null}
    </svg>
  );
};

/** The static logo mark, exactly as the dashboard draws it. */
export const Logo: React.FC<{ size: number; ink?: string; bg?: string }> = ({ size, ink = C.ink, bg = C.paper }) => (
  <svg width={size} height={size} viewBox="0 0 26 26">
    <path d="M2 24V5h5v5h4V5h4v5h4V5h5v19z" fill={ink} />
    <path d="M11.5 24v-4.5a1.5 1.5 0 0 1 3 0V24z" fill={bg} />
  </svg>
);

export const wallEase = expo;
