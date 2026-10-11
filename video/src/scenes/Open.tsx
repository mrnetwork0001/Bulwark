import React from "react";
import { AbsoluteFill, interpolate, random, useCurrentFrame } from "remotion";
import { C, inter, mono } from "../theme";
import { clamp, expo, pop, ramp } from "../ui/motion";
import { useRel } from "../ui/kit";
import { Wall, ATTACK_BRICKS } from "../ui/Wall";
import { Words } from "../ui/Words";
import data from "../data.json";

const T = data.trial;

/** The real double refund: RefundBot, timeout-after-commit, seed 1286473109, replayed from its seed. */
export const Open: React.FC = () => {
  const f = useCurrentFrame();
  const rel = useRel("open");
  const tCustomer = rel("customer");
  const tRefund = rel("refund");
  const tThrough = rel("through,");
  const tSlow = rel("slow.");
  const tOne = rel("one");
  const tGives = rel("gives");
  const tTries = rel("tries");
  const tAgain = rel("again.");
  const t98 = rel("Ninety-eight");
  const tOrder2 = rel("order.", 1);

  // Real events from the replay (times in ms since the trial started).
  const ev = T.events;
  const refundCall = ev.find((e) => e.type === "call" && e.endpoint === "refunds.create")!;
  const timeout = ev.find((e) => e.type === "timeout")!;
  const retry = ev.find((e) => e.type === "call" && e.retryOf)!;
  const [rf1, rf2] = T.refunds;
  const rows: { at: number; t: number; tag: string; text: string; color?: string }[] = [
    { at: tRefund - 8, t: ev[0].t, tag: "TOOL", text: `lookup_order  ${T.order!.id}` },
    { at: tRefund + 2, t: ev.find((e) => e.name === "search_policy")!.t, tag: "TOOL", text: "search_policy  \"refund eligibility\"" },
    { at: tRefund + 12, t: refundCall.t, tag: "CALL", text: `issue_refund → refunds.create  $${refundCall.input?.amount}` },
    { at: tThrough - 6, t: refundCall.t, tag: "LEDGER", text: `refund ${rf1.id}  ${rf1.orderId}  $${rf1.amount}`, color: "#fff" },
    { at: tSlow - 14, t: refundCall.t, tag: "FAULT", text: "response held back (timeout-after-commit)", color: C.g1 },
    { at: tGives - 4, t: timeout.t, tag: "TIMEOUT", text: `gave up after ~${timeout.afterMs}ms · request still in flight`, color: C.g1 },
    { at: tTries - 2, t: retry.t, tag: "RETRY", text: `refunds.create  $${retry.input?.amount}  · no idempotency key`, color: "#fff" },
    { at: tAgain + 6, t: retry.t, tag: "LEDGER", text: `refund ${rf2.id}  ${rf2.orderId}  $${rf2.amount}`, color: "#FCA5A5" },
  ];

  // The ms clock: 0 → 1001 between "slow." and "second,".
  const clockP = interpolate(f, [tSlow, tOne + 10], [0, 1], clamp);
  const ms = Math.round(clockP * (timeout.afterMs ?? 1001));
  const clockOp = interpolate(f, [tSlow - 6, tSlow + 4, t98 - 10, t98], [0, 1, 1, 0], clamp);

  // Full-bleed alarm at "Ninety-eight".
  const flood = ramp(f, t98 - 4, t98 + 8);
  const shake = f > t98 - 2 && f < t98 + 16 ? (random(`k${f}`) - 0.5) * 16 * (1 - (f - t98 + 2) / 18) : 0;
  const termOut = interpolate(f, [t98 - 6, t98 + 6], [1, 0], clamp);
  const big = pop(f, t98);

  return (
    <AbsoluteFill style={{ background: C.night, color: "#fff", fontFamily: inter, transform: `translate(${shake}px, ${shake * 0.5}px)` }}>
      <AbsoluteFill style={{ background: C.alarm, opacity: flood }} />

      {/* Header: what this is */}
      <div style={{ position: "absolute", left: 120, top: 120, fontFamily: mono, fontSize: 18, letterSpacing: "0.1em", color: "rgba(255,255,255,0.6)", opacity: ramp(f, 2, 18) * termOut }}>
        REAL TRIAL · REFUNDBOT · FAULT {T.fault.toUpperCase()} · SEED {T.seed}
      </div>

      {/* The ticket */}
      <div style={{ position: "absolute", left: 120, top: 180, width: 860, opacity: ramp(f, tCustomer - 4, tCustomer + 10) * termOut, transform: `translateY(${(1 - ramp(f, tCustomer - 4, tCustomer + 14)) * 20}px)` }}>
        <div style={{ fontSize: 46, fontWeight: 300, letterSpacing: "-0.03em", lineHeight: 1.15 }}>“{T.ticket.message}”</div>
        <div style={{ marginTop: 14, fontFamily: mono, fontSize: 17, color: "rgba(255,255,255,0.5)" }}>
          {T.ticket.customerEmail} · {T.order!.id} · ${T.order!.total} order
        </div>
      </div>

      {/* The trial, event by event */}
      <div style={{ position: "absolute", left: 120, top: 400, width: 980, borderRadius: 20, background: "#121212", boxShadow: "0 0 0 1px rgba(255,255,255,0.1)", padding: "22px 0", opacity: ramp(f, tRefund - 12, tRefund) * termOut }}>
        {rows.map((r, i) => {
          const p = interpolate(f, [r.at, r.at + 8], [0, 1], { ...clamp, easing: expo });
          const tagColor = r.tag === "FAULT" || r.tag === "TIMEOUT" ? C.g1 : r.tag === "RETRY" ? "#FCA5A5" : r.tag === "LEDGER" ? "#fff" : "rgba(255,255,255,0.45)";
          const hot = r.tag === "LEDGER" && i === rows.length - 1;
          return (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "120px 130px 1fr", alignItems: "center", padding: "9px 30px", fontFamily: mono, fontSize: 21, opacity: p, transform: `translateX(${(1 - p) * -16}px)`, background: hot ? "rgba(220,38,38,0.28)" : undefined }}>
              <span style={{ color: "rgba(255,255,255,0.35)" }}>+{r.t}ms</span>
              <span style={{ color: tagColor, fontSize: 16, letterSpacing: "0.08em" }}>{r.tag}</span>
              <span style={{ color: r.color ?? "rgba(255,255,255,0.82)" }}>{r.text}</span>
            </div>
          );
        })}
      </div>

      {/* The clock: the agent waits one second */}
      <div style={{ position: "absolute", left: 1230, top: 640, width: 520, opacity: clockOp }}>
        <div style={{ fontFamily: mono, fontSize: 16, letterSpacing: "0.1em", color: "rgba(255,255,255,0.5)" }}>WAITING FOR refunds.create</div>
        <div style={{ fontSize: 120, fontWeight: 200, letterSpacing: "-0.04em", fontVariantNumeric: "tabular-nums", color: ms >= 1000 ? C.g1 : "#fff" }}>{ms}<span style={{ fontSize: 48, marginLeft: 8 }}>ms</span></div>
        <div style={{ height: 4, borderRadius: 2, background: "rgba(255,255,255,0.12)", overflow: "hidden" }}>
          <div style={{ width: `${clockP * 100}%`, height: "100%", background: clockP >= 1 ? C.g1 : "#fff" }} />
        </div>
      </div>

      {/* The wall: whole, until the retry knocks a brick out */}
      <div style={{ position: "absolute", left: 1290, top: 150, opacity: interpolate(f, [0, 16, t98 - 6, t98 + 4], [0, 1, 1, 0], clamp) }}>
        <Wall size={400} ink="rgba(255,255,255,0.92)" bg={C.night} build={[2, 40]} knocks={[{ i: ATTACK_BRICKS[0], at: tAgain }]} />
      </div>

      {/* $98 on a $49 order */}
      <AbsoluteFill style={{ justifyContent: "center", paddingLeft: 140, opacity: flood }}>
        <div style={{ fontSize: 330, fontWeight: 300, letterSpacing: "-0.06em", lineHeight: 0.9, transform: `scale(${0.8 + 0.2 * big})`, transformOrigin: "left center" }}>
          ${rf1.amount + rf2.amount}
        </div>
        <div style={{ marginTop: 30, fontSize: 68, fontWeight: 300, letterSpacing: "-0.03em" }}>
          <Words text={`refunded on a $${T.order!.total} order.`} at={rel("refunded")} every={4} />
        </div>
        <div style={{ marginTop: 44, display: "flex", flexDirection: "column", gap: 10 }}>
          {T.broken.map((b, i) => {
            const p = ramp(f, tOrder2 + 4 + i * 8, tOrder2 + 16 + i * 8);
            return (
              <div key={i} style={{ fontFamily: mono, fontSize: 22, opacity: p, transform: `translateY(${(1 - p) * 10}px)` }}>
                ✗ {b.rule} <span style={{ opacity: 0.7 }}>({b.detail})</span>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
