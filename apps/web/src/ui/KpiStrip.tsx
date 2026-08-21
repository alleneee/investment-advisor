import type { ReactNode } from "react";

export function KpiStrip({ children }: { children: ReactNode }) {
  return (
    <div className="ui-kpi" role="group">
      {children}
    </div>
  );
}
