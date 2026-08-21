export type StructureState = "confirmed" | "provisional";
export type Timeframe = "1d" | "1w";

export interface ChartBar {
  occurredAt: string;
  open: number;
  close: number;
  low: number;
  high: number;
  volume: number | null;
}

export interface ChartStroke {
  direction: "up" | "down";
  startAt: string;
  endAt: string;
  startPrice: number;
  endPrice: number;
  state: StructureState;
}

export interface ChartCenter {
  startAt: string;
  endAt: string;
  lower: number;
  upper: number;
}

export interface ChanChartData {
  timeframe: Timeframe;
  bars: ChartBar[];
  strokes: ChartStroke[];
  centers: ChartCenter[];
}

export interface WatchItem {
  symbol: string;
  name: string;
  market: "SH" | "SZ";
}

export interface RunProgress {
  symbol: string;
  name: string;
  stage: string;
  state: "queued" | "running" | "completed" | "degraded" | "failed";
  reportId?: string;
}

export interface StructureFact {
  id: string;
  kind: "stroke" | "center" | "fractal";
  state: StructureState;
  label: string;
  value: string;
}

export interface Report {
  symbol: string;
  name: string;
  asOf: string;
  timeframe: Timeframe;
  chart: ChanChartData;
  headline: string;
  conclusion: string;
  structure: StructureFact[];
  quality: "ok" | "degraded";
  qualityNote: string;
  sources: string[];
  review: "未审阅" | "已接受" | "需跟进" | "已驳回";
}

export type InformationQualityStatus = "ok" | "degraded" | "unavailable";
export type InformationSourceStatus = "fresh" | "cached" | "stale" | "unavailable";

export interface StockNews {
  id: string;
  title: string;
  summary: string;
  publishedAt: string;
  source: string;
  url: string | null;
}

export interface StockMessage {
  id: string;
  question: string;
  answer: string | null;
  answerer: string | null;
  publishedAt: string;
  source: string;
}

export interface StockSentiment {
  hotRank: number | null;
  heat: number | null;
  rankChange: number | null;
  concepts: string[];
  tag: string | null;
  observedAt: string | null;
}

export interface InformationSourceQuality {
  status: InformationSourceStatus;
  fetchedAt: string | null;
}

export interface StockInformation {
  symbol: string;
  snapshotId: string;
  generatedAt: string;
  news: StockNews[];
  messages: StockMessage[];
  sentiment: StockSentiment;
  quality: {
    status: InformationQualityStatus;
    warnings: string[];
    sources: {
      eastmoneyNews: InformationSourceQuality;
      cninfoIrm: InformationSourceQuality;
      thsHotList: InformationSourceQuality;
    };
  };
}

export type InvestmentReportStatus = "queued" | "running" | "completed" | "failed";
export type InvestmentScenarioCase = "bullish" | "base" | "bearish";
export type InvestmentDirection = "bullish" | "sideways" | "bearish" | "uncertain";
export type InvestmentConfidence = "low" | "medium" | "high";
export type ReferenceKind = "market" | "price_level" | "structure" | "news" | "irm" | "hot" | "information_quality";
export type ReferenceValue = string | number | boolean | null;

export interface ReferenceFact {
  ref: string;
  kind: ReferenceKind;
  label: string;
  value: ReferenceValue;
  unit?: string;
  occurredAt?: string;
  url?: string | null;
}

export interface ReportCondition {
  operator: "break_above" | "hold_above" | "break_below" | "hold_below" | "structure_confirmed" | "structure_invalidated";
  factRef: string;
  fact: ReferenceFact;
}

export interface InvestmentScenario {
  case: InvestmentScenarioCase;
  narrative: string;
  trigger: ReportCondition;
  invalidation: ReportCondition;
  evidenceRefs: string[];
  evidence: ReferenceFact[];
}

export interface InvestmentRisk {
  narrative: string;
  evidenceRefs: string[];
  evidence: ReferenceFact[];
}

export interface InvestmentReport {
  id: string;
  schemaVersion: "investment_report.v2";
  runId: string;
  symbol: string;
  timeframe: Timeframe;
  asOf: string;
  generatedAt: string;
  title: string;
  executiveSummary: string;
  references: Record<string, ReferenceFact>;
  outlook: {
    horizon: "5-20-trading-days";
    direction: InvestmentDirection;
    confidence: InvestmentConfidence;
    thesis: string;
    scenarios: InvestmentScenario[];
  };
  risks: InvestmentRisk[];
  evidenceRefs: string[];
  evidence: ReferenceFact[];
  disclaimer: string;
  review: { status: "pending" };
}

export interface InvestmentReportError {
  code: string;
  message: string;
  retryable: boolean;
}

export type ReportReviewStatus = "pending" | "accepted" | "rejected";
export type ReportReviewDecision = "accepted" | "rejected";
export type ReportOutcomeStatus = "pending" | "realized" | "none_realized" | "ambiguous" | "inconclusive";
export type ReportOutcomeAdjudication =
  | "window_pending"
  | "single_candidate"
  | "active_breakout_precedence"
  | "multiple_active_breakouts"
  | "passive_only"
  | "no_candidate";

export interface ReportConditionOutcome {
  operator: ReportCondition["operator"];
  factRef: string;
  level: string | null;
  hit: boolean | null;
  decisiveDate: string | null;
  unevaluableReason: string | null;
}

export interface ReportScenarioOutcome {
  case: InvestmentScenarioCase;
  trigger: ReportConditionOutcome;
  invalidation: ReportConditionOutcome;
}

export interface ReportOutcome {
  reportId: string;
  symbol: string;
  asOf: string;
  evaluatedAt: string;
  status: ReportOutcomeStatus;
  adjudication: ReportOutcomeAdjudication;
  realizedCase: InvestmentScenarioCase | null;
  realizedCases: InvestmentScenarioCase[];
  window: { start: string | null; end: string | null; barCount: number; requiredBars: number };
  scenarios: ReportScenarioOutcome[];
  quality: { status: InformationQualityStatus; warnings: string[] };
}

export interface InvestmentReportJob {
  reportId: string;
  status: InvestmentReportStatus;
  symbol: string;
  timeframe: Timeframe;
  asOf: string;
  inputDigest: string;
  attemptCount: number;
  updatedAt: string;
  report: InvestmentReport | null;
  error: InvestmentReportError | null;
  reviewStatus: ReportReviewStatus;
  reviewedAt: string | null;
  publishedAt: string | null;
  shareToken: string | null;
  outcome: ReportOutcome | null;
}

export interface ReportShare {
  reportId: string;
  shareToken: string;
  shareUrlPath: string;
}

export interface SharedReportOutcome {
  status: ReportOutcomeStatus;
  realizedCase: InvestmentScenarioCase | null;
  evaluatedAt: string;
  window: { start: string | null; end: string | null; barCount: number; requiredBars: number };
  quality: { status: InformationQualityStatus; warnings: string[] };
}

export interface SharedReport {
  symbol: string;
  timeframe: Timeframe;
  asOf: string;
  generatedAt: string;
  publishedAt: string;
  title: string;
  executiveSummary: string;
  outlook: InvestmentReport["outlook"];
  risks: InvestmentRisk[];
  evidence: ReferenceFact[];
  disclaimer: string;
  chart: ChanChartData;
  quality: { status: "ok" | "degraded"; warnings: string[] };
  outcome: SharedReportOutcome | null;
}

export interface ReportPublication {
  reportId: string;
  publishedAt: string;
  reviewStatus: ReportReviewStatus;
}

export interface InvestmentReportRequest {
  reportId: string;
  status: InvestmentReportStatus;
  cached: boolean;
}
