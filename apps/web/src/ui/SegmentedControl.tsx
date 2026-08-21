import type { ReactNode } from "react";

export function SegmentedControl({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={["ui-segment", className].filter(Boolean).join(" ")}>{children}</div>;
}
