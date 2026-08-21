import type { ReactNode } from "react";

export function SplitPane({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="ui-split">
      <div className="ui-split-pane">{left}</div>
      <div className="ui-split-pane">{right}</div>
    </div>
  );
}
