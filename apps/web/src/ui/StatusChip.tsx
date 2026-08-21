import type { MetricTone } from "./formatDisplay";

export function StatusChip({ label, tone }: { label: string; tone: MetricTone }) {
  return <span className={`ui-chip tone-${tone}`}>{label}</span>;
}
