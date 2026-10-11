import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { serif, C } from "../theme";
import { clamp, expo } from "./motion";

/**
 * Kinetic type: each word rises and sharpens in turn, starting at `at`
 * (frame relative to the parent Sequence), `every` frames apart. Words named
 * in `accent` are set in the italic serif in the accent colour, the way the
 * reference film sets its one emphasised word.
 */
export const Words: React.FC<{
  text: string;
  at: number;
  every?: number;
  accent?: Record<string, string>;
  out?: number;
  style?: React.CSSProperties;
  serifScale?: number;
}> = ({ text, at, every = 3, accent = {}, out, style, serifScale = 1.12 }) => {
  const f = useCurrentFrame();
  const words = text.split(" ");
  const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, "");
  const acc8 = Object.fromEntries(Object.entries(accent).map(([k, v]) => [norm(k), v]));
  const fade = out != null ? interpolate(f, [out, out + 10], [1, 0], clamp) : 1;
  return (
    <span style={{ display: "inline", opacity: fade, ...style }}>
      {words.map((w, i) => {
        const t = at + i * every;
        const p = interpolate(f, [t, t + 14], [0, 1], { ...clamp, easing: expo });
        const acc = acc8[norm(w)];
        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              opacity: p,
              transform: `translateY(${(1 - p) * 0.42}em)`,
              filter: `blur(${(1 - p) * 8}px)`,
              marginRight: "0.24em",
              ...(acc ? { fontFamily: serif, fontStyle: "italic", fontWeight: 400, color: acc, fontSize: `${serifScale}em`, letterSpacing: "-0.01em" } : {}),
            }}
          >
            {w}
          </span>
        );
      })}
    </span>
  );
};

export const ACCENT = C.ink;
