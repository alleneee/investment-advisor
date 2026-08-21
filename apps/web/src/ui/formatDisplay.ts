export type MetricTone = "up" | "down" | "risk" | "neutral";

export function formatMoney(text: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return text;
  const grouped = match[2].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return match[3] == null ? `${match[1]}${grouped}` : `${match[1]}${grouped}.${match[3]}`;
}

export function formatSignedMoney(text: string): string {
  const formatted = formatMoney(text);
  if (formatted === text && !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return text;
  if (/^-?0+(?:\.0+)?$/.test(text)) return formatMoney(text.replace(/^-/, ""));
  return text.startsWith("-") ? formatted : `+${formatted}`;
}

export function formatRate(text: string): string {
  const value = Number(text);
  if (!Number.isFinite(value)) return text;
  return `${(value * 100).toFixed(2)}%`;
}

export function signedTone(text: string): MetricTone {
  if (/^-?0+(?:\.0+)?$/.test(text)) return "neutral";
  return text.startsWith("-") ? "down" : "up";
}
