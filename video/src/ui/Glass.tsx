import React from "react";

/** The app's frosted card. */
export const Glass: React.FC<{ style?: React.CSSProperties; children?: React.ReactNode; dark?: boolean }> = ({ style, children, dark }) => (
  <div style={{
    borderRadius: 28,
    background: dark ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.72)",
    border: dark ? "1px solid rgba(255,255,255,0.14)" : "1px solid rgba(255,255,255,0.85)",
    boxShadow: dark
      ? "0 20px 60px rgba(0,0,0,0.35)"
      : "inset 1px 1px 0 rgba(255,255,255,0.55), 0 0 0 1.3px rgba(120,145,180,0.18), 0 24px 60px rgba(28,52,92,0.10)",
    backdropFilter: "blur(30px)",
    ...style,
  }}>{children}</div>
);
