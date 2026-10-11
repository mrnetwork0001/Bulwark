import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadMono } from "@remotion/google-fonts/GeistMono";
import { loadFont as loadSerif } from "@remotion/google-fonts/InstrumentSerif";

export const inter = loadInter("normal", { weights: ["200", "300", "400", "500", "600"], subsets: ["latin"] }).fontFamily;
export const mono = loadMono("normal", { weights: ["400", "500"], subsets: ["latin"] }).fontFamily;
export const serif = loadSerif("italic", { weights: ["400"], subsets: ["latin"] }).fontFamily;

/** Bulwark's design system (bulwark/dashboard/theme.css): monochrome, colour only for meaning. */
export const C = {
  paper: "#FFFFFF",
  paper2: "#FAFAFA",
  muted: "#F4F4F6",
  ink: "#0A0A0A",
  ink2: "rgba(10,10,10,0.56)",
  dim: "rgba(10,10,10,0.38)",
  line: "rgba(0,0,0,0.08)",
  lineStrong: "rgba(0,0,0,0.12)",
  night: "#0A0A0A",
  night2: "#141414",
  // Meaning
  pass: "#15803D",
  crash: "#DC2626",
  broken: "#B45309",
  blue: "#1D4ED8",
  guard: "#0F766E",
  // The resilience gradient and the two full-bleed states
  g0: "#EF4444",
  g1: "#F59E0B",
  g2: "#10B981",
  alarm: "#DC2626",
  alarmDeep: "#B91C1C",
  proof: "#059669",
  proofDeep: "#047857",
};
export const GRAD = `linear-gradient(90deg, ${C.g0} 0%, ${C.g1} 45%, ${C.g2} 100%)`;

export type Tone = "light" | "night" | "alarm";
export const TONE: Record<Tone, { bg: string; ink: string; muted: string; line: string }> = {
  light: { bg: C.paper, ink: C.ink, muted: "rgba(10,10,10,0.5)", line: C.line },
  night: { bg: C.night, ink: "#FFFFFF", muted: "rgba(255,255,255,0.55)", line: "rgba(255,255,255,0.12)" },
  alarm: { bg: C.alarm, ink: "#FFFFFF", muted: "rgba(255,255,255,0.72)", line: "rgba(255,255,255,0.22)" },
};

/** Which look each scene uses; the corner chrome and captions follow it. */
export const SCENE_TONE: Record<string, Tone> = {
  open: "night", problem: "light", turn: "light", attack: "light", fix: "night",
  prove: "night", result: "alarm", tools: "light", different: "night", close: "light",
};

export const SCENE_LABEL: Record<string, string> = {
  open: "01 · a real trial", problem: "02 · the problem", turn: "03 · bulwark", attack: "04 · red attacks",
  fix: "05 · the judge decides", prove: "06 · proof, not luck", result: "07 · the result", tools: "08 · built with",
  different: "09 · what single-fault testing misses", close: "10 · break it first",
};
