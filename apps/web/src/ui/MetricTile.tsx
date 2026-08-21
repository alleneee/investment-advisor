import type { ReactNode } from "react";
import type { MetricTone } from "./formatDisplay";

export function MetricTile({
  label,
  value,
  tone = "neutral",
  detail,
}: {
  label: string;
  value: ReactNode;
  tone?: MetricTone;
  detail?: string;
}) {
  return (
    <article>
      <span>{label}</span>
      <strong className={`ui-metric-value tone-${tone}`}>{value}</strong>
      {detail != null ? <small>{detail}</small> : null}
    </article>
  );
}
