import type { ReactNode } from "react";
import { Inbox } from "lucide-react";
import { Icon } from "./Icon";

export function EmptyState({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="ui-empty">
      <Icon icon={Inbox} />
      <p>{title}</p>
      {action}
    </div>
  );
}
