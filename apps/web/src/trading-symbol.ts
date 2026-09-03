const BARE = /^\d{6}$/;

export function normalizeTradingSymbol(symbol: string): string {
  const text = symbol.trim().toUpperCase();
  if (!BARE.test(text)) return text;
  if (/^(600|601|603|605|688)/.test(text)) return `${text}.SH`;
  if (/^(000|001|002|003|300|301)/.test(text)) return `${text}.SZ`;
  return text;
}
