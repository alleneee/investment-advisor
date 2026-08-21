import type { ReactNode } from "react";

export function SplitPane({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="ui-split">
      {left}
      {right}
    </div>
  );
}
