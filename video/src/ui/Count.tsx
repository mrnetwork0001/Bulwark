import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { clamp, expo } from "./motion";

/**
 * A figure that counts from `from` to its real value between frames `at` and `at + dur`.
 * Before `at` it shows `from` (pass the honest starting value, e.g. the "before" figure),
 * or nothing when `hideBefore` is set, so it never flashes a misleading 0.
 */
export const Count: React.FC<{ to: number; at: number; from?: number; hideBefore?: boolean; dur?: number; decimals?: number; prefix?: string; suffix?: string; style?: React.CSSProperties }> = ({ to, at, from = 0, hideBefore, dur = 36, decimals = 0, prefix = "", suffix = "", style }) => {
  const f = useCurrentFrame();
  const v = interpolate(f, [at, at + dur], [from, to], { ...clamp, easing: expo });
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const op = hideBefore ? interpolate(f, [at - 1, at + 4], [0, 1], clamp) : 1;
  return <span style={{ fontVariantNumeric: "tabular-nums", opacity: op, ...style }}>{prefix}{v < 0 ? "−" : ""}{s}{suffix}</span>;
};
