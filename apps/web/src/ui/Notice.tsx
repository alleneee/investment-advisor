import { AlertTriangle } from "lucide-react";
import { Icon } from "./Icon";

export function Notice({ title, detail }: { title: string; detail?: string }) {
  return (
    <div role="alert" className="notice">
      <Icon icon={AlertTriangle} />
      <strong>{title}</strong>
      {detail != null ? <span>{detail}</span> : null}
    </div>
  );
}
