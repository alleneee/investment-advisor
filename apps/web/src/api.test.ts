import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createHttpApi,
  mapPool,
  toInvestmentReportJob,
  toReport,
  toReportOutcome,
  toReportPublication,
  toReportQuality,
  toReportShare,
  toSharedReport,
  toStockInformation,
} from "./api";

function payload() {
  return {
    market_snapshot: {
      snapshot_id: "snapshot-1",
      source: "tushare",
      adjustment: "qfq",
      bars: [
        { occurred_at: "2024-08-01T00:00:00Z", open: "8", close: "8.5", low: "7", high: "10", volume: "80" },
        { occurred_at: "2024-08-02T00:00:00Z", open: "8.5", close: "9", low: "8", high: "9.5", volume: null },
        { occurred_at: "2024-08-05T00:00:00Z", open: "9", close: "11", low: "9", high: "12", volume: "100" },
      ],
      window: { start: "20240801", end: "20240805", bar_count: 3 },
      facts: [],
      quality: { status: "ok" as const, warnings: [] },
    },
    chan_analysis: {
      analysis_id: "chan-1",
      engine_version: "chan-engine.v1",
      timeframe: "1d",
      snapshot: {
        bars: [
          { occurred_at: "2024-08-01T00:00:00Z" },
          { occurred_at: "2024-08-05T00:00:00Z" },
        ],
        strokes: [],
        confirmed: [
          { direction: "up", start_index: 0, end_index: 1, start_price: "7", end_price: "12" },
        ],
        provisional: [
          { direction: "down", start_index: 1, end_index: 1, start_price: "12", end_price: "11" },
        ],
        centers: [
          { start_index: 0, end_index: 1, lower: "8", upper: "10" },
        ],
      },
    },
  };
}

function informationPayload() {
  return {
    symbol: "002940.SZ",
    snapshot_id: "information-1",
    generated_at: "2026-08-13T09:00:00+08:00",
    news: [{
      id: "news-1",
      title: "公司发布经营进展",
      summary: "经营保持稳定",
      published_at: "2026-08-13T08:00:00+08:00",
      source: "东财",
      url: "https://example.com/news/1",
    }],
    messages: [{
      id: "irm-1",
      question: "产能进展如何",
      answer: "按计划推进",
      answerer: "证券部",
      published_at: "2026-08-12T16:00:00+08:00",
      source: "cninfo",
    }],
    sentiment: {
      hot_rank: 8,
      heat: 9123,
      rank_change: 2,
      concepts: ["机器人"],
      tag: "热股",
      observed_at: "2026-08-13T09:00:00+08:00",
    },
    quality: {
      status: "ok",
      warnings: [],
      sources: {
        eastmoney_news: { status: "fresh", fetched_at: "2026-08-13T09:00:00+08:00" },
        cninfo_irm: { status: "cached", fetched_at: "2026-08-13T08:00:00+08:00" },
        ths_hot_list: { status: "stale", fetched_at: "2026-08-13T07:00:00+08:00" },
      },
    },
  };
}

function reportEnvelope() {
  const closeFact = { ref: "market.latest_close", kind: "price_level", label: "最新收盘", value: 20.6, unit: "CNY", occurred_at: "2026-08-12T15:00:00+08:00" };
  const structureFact = { ref: "chan.structure", kind: "structure", label: "当前结构", value: "中枢震荡" };
  const newsFact = { ref: "news.latest", kind: "news", label: "公司进展", value: "经营保持稳定", url: "https://example.com/news/1" };
  const scenarioInputs: Array<[string, string, string, typeof closeFact | typeof structureFact]> = [
    ["bullish", "结构确认后观察偏强情景。", "break_above", closeFact],
    ["base", "中枢约束下保持基准观察。", "structure_confirmed", structureFact],
    ["bearish", "结构失效后观察偏弱情景。", "break_below", closeFact],
  ];
  const scenarios = scenarioInputs.map(([scenarioCase, narrative, operator, fact]) => ({
    case: scenarioCase,
    narrative,
    trigger: { operator, fact_ref: fact.ref, fact },
    invalidation: { operator: "structure_invalidated", fact_ref: structureFact.ref, fact: structureFact },
    evidence_refs: [fact.ref, newsFact.ref],
    evidence: [fact, newsFact],
  }));
  return {
    report_id: "report-1",
    status: "completed",
    symbol: "002940.SZ",
    timeframe: "1w",
    as_of: "2026-08-13",
    input_digest: "digest-1",
    attempt_count: 1,
    updated_at: "2026-08-13T09:06:00+08:00",
    report: {
      id: "report-1",
      schema_version: "investment_report.v2",
      run_id: "run-1",
      symbol: "002940.SZ",
      timeframe: "1w",
      as_of: "2026-08-13",
      generated_at: "2026-08-13T09:05:00+08:00",
      title: "结构与资讯综合研判",
      executive_summary: "结构处于等待确认阶段。",
      market_snapshot: { snapshot_id: "market-1" },
      chan_analysis: { analysis_id: "chan-1" },
      information_snapshot: informationPayload(),
      draft: { raw: "不会交给组件" },
      reference_registry: {
        [closeFact.ref]: closeFact,
        [structureFact.ref]: structureFact,
        [newsFact.ref]: newsFact,
      },
      outlook: {
        horizon: "5-20-trading-days",
        direction: "uncertain",
        confidence: "medium",
        thesis: "以后续结构确认与失效条件切换情景。",
        scenarios,
      },
      risks: [{ narrative: "资讯存在时效差异。", evidence_refs: [newsFact.ref], evidence: [newsFact] }],
      evidence_refs: [closeFact.ref, structureFact.ref, newsFact.ref],
      evidence: [closeFact, structureFact, newsFact],
      disclaimer: "本报告基于固化数据生成，仅供研究参考，不构成任何投资建议。",
      review: { status: "pending" },
    },
    error: null,
    review_status: "pending",
    reviewed_at: null,
    published_at: null,
    share_token: null,
    outcome: null,
  };
}

export function outcomePayload() {
  return {
    schema_version: "report_outcome.v1",
    report_id: "report-1",
    symbol: "002940.SZ",
    as_of: "2026-08-13",
    evaluated_at: "2026-09-12T09:00:00+08:00",
    window: { start: "20260814", end: "20260911", bar_count: 20, required_bars: 20 },
    scenarios: [
      {
        case: "bullish",
        trigger: {
          operator: "break_above",
          fact_ref: "market.recent_high",
          level: "21.00",
          hit: true,
          decisive_date: "20260818",
          unevaluable_reason: null,
        },
        invalidation: {
          operator: "structure_invalidated",
          fact_ref: "chan.structure",
          hit: null,
          decisive_date: null,
          unevaluable_reason: "structure_condition_not_replayable",
        },
      },
    ],
    quality: { status: "ok", warnings: [] },
    status: "realized",
    adjudication: "single_candidate",
    realized_case: "bullish",
    realized_cases: ["bullish"],
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mutableReportEnvelope(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(reportEnvelope())) as Record<string, unknown>;
}

function nestedRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function nestedArray(value: unknown): Array<Record<string, unknown>> {
  return value as Array<Record<string, unknown>>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("market analysis adapter", () => {
  it("keeps raw bars and maps Chan indexes to dates", () => {
    const report = toReport("600000.SH", "1d", payload());

    expect(report.timeframe).toBe("1d");
    expect(report.chart.bars).toHaveLength(3);
    expect(report.chart.bars[0].volume).toBe(80);
    expect(report.chart.bars[1].volume).toBeNull();
    expect(report.chart.strokes[0]).toMatchObject({
      startAt: "2024-08-01T00:00:00Z",
      endAt: "2024-08-05T00:00:00Z",
      state: "confirmed",
    });
    expect(report.chart.centers[0]).toMatchObject({
      startAt: "2024-08-01T00:00:00Z",
      endAt: "2024-08-05T00:00:00Z",
      lower: 8,
      upper: 10,
    });
  });

  it.each([
    ["non-finite OHLC", (value: ReturnType<typeof payload>) => { value.market_snapshot.bars[1].high = "Infinity"; }],
    ["duplicate dates", (value: ReturnType<typeof payload>) => { value.market_snapshot.bars[1].occurred_at = value.market_snapshot.bars[0].occurred_at; }],
    ["unordered dates", (value: ReturnType<typeof payload>) => { [value.market_snapshot.bars[0], value.market_snapshot.bars[1]] = [value.market_snapshot.bars[1], value.market_snapshot.bars[0]]; }],
  ])("rejects %s without changing the time axis", (_name, mutate) => {
    const value = payload();
    mutate(value);

    expect(() => toReport("600000.SH", "1d", value)).toThrow(ApiError);
  });

  it("filters invalid structures without shifting valid date coordinates", () => {
    const value = payload();
    value.chan_analysis.snapshot.confirmed.push(
      { direction: "up", start_index: 0, end_index: 4, start_price: "7", end_price: "12" },
      { direction: "up", start_index: 0, end_index: 1, start_price: "NaN", end_price: "12" },
      { direction: "down", start_index: 1, end_index: 0, start_price: "12", end_price: "7" },
    );
    value.chan_analysis.snapshot.centers.push(
      { start_index: 0, end_index: 1, lower: "10", upper: "10" },
      { start_index: 0, end_index: 4, lower: "8", upper: "10" },
    );

    const report = toReport("600000.SH", "1d", value);

    expect(report.chart.strokes).toHaveLength(2);
    expect(report.chart.strokes[0].startAt).toBe("2024-08-01T00:00:00Z");
    expect(report.chart.centers).toHaveLength(1);
  });
});

describe("information and investment report API", () => {
  it("creates and polls a full report job for every stock in the batch", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/watchlist") {
        return jsonResponse([
          { symbol: "002940.SZ", name: "昂利康" },
          { symbol: "002309.SZ", name: "中利集团" },
        ]);
      }
      if (path === "/api/market/002940.SZ/reports" && init?.method === "POST") {
        return jsonResponse({ report_id: "report-002940", status: "queued", cached: false }, 202);
      }
      if (path === "/api/market/002309.SZ/reports" && init?.method === "POST") {
        return jsonResponse({ report_id: "report-002309", status: "queued", cached: false }, 202);
      }
      const symbol = path.endsWith("report-002940") ? "002940.SZ" : "002309.SZ";
      return jsonResponse({
        report_id: path.endsWith("report-002940") ? "report-002940" : "report-002309",
        status: path.endsWith("report-002940") ? "running" : "failed",
        symbol,
        timeframe: "1d",
        as_of: "2026-08-13",
        input_digest: `digest-${symbol}`,
        attempt_count: 1,
        updated_at: "2026-08-13T09:06:00+08:00",
        report: null,
        error: path.endsWith("report-002940") ? null : { code: "PROVIDER_ERROR", message: "生成失败", retryable: true },
        review_status: "pending",
        reviewed_at: null,
        published_at: null,
        share_token: null,
        outcome: null,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = createHttpApi("");

    await api.createBatch();
    const progress = await api.getProgress();

    expect(fetchMock).toHaveBeenCalledWith("/api/market/002940.SZ/reports", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ timeframe: "1d" }),
    }));
    expect(fetchMock).toHaveBeenCalledWith("/api/market/002309.SZ/reports", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ timeframe: "1d" }),
    }));
    expect(fetchMock).not.toHaveBeenCalledWith("/api/batches", expect.anything());
    expect(progress).toEqual([
      { symbol: "002940.SZ", name: "昂利康", reportId: "report-002940", stage: "报告生成", state: "running" },
      { symbol: "002309.SZ", name: "中利集团", reportId: "report-002309", stage: "生成失败", state: "failed" },
    ]);
  });

  it("limits batch creates to two concurrent requests", async () => {
    let inflight = 0;
    let peak = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/watchlist") {
        return jsonResponse([
          { symbol: "002940.SZ", name: "昂利康" },
          { symbol: "002309.SZ", name: "中利集团" },
          { symbol: "600519.SH", name: "贵州茅台" },
        ]);
      }
      if (init?.method === "POST") {
        inflight += 1;
        peak = Math.max(peak, inflight);
        await Promise.resolve();
        inflight -= 1;
        const symbol = path.split("/")[3];
        return jsonResponse({ report_id: `report-${symbol}`, status: "queued", cached: false }, 202);
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
    await createHttpApi("").createBatch();
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("restores batch progress from persisted jobs after a reload", async () => {
    const jobPayload = {
      report_id: "report-002940",
      status: "running",
      symbol: "002940.SZ",
      timeframe: "1d",
      as_of: "2026-08-13",
      input_digest: "digest-1",
      attempt_count: 1,
      updated_at: "2026-08-13T09:06:00+08:00",
      report: null,
      error: null,
      review_status: "pending",
      reviewed_at: null,
      published_at: null,
      share_token: null,
      outcome: null,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/watchlist") {
        return jsonResponse([{ symbol: "002940.SZ", name: "昂利康" }]);
      }
      if (path.startsWith("/api/reports/jobs")) {
        return jsonResponse([jobPayload]);
      }
      if (path === "/api/reports/report-002940") {
        return jsonResponse(jobPayload);
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const progress = await createHttpApi("").getProgress();
    expect(fetchMock).toHaveBeenCalledWith("/api/reports/jobs?timeframe=1d", expect.any(Object));
    expect(progress).toEqual([
      { symbol: "002940.SZ", name: "昂利康", reportId: "report-002940", stage: "报告生成", state: "running" },
    ]);
  });

  it("lists the research archive and maps the quality dashboard", async () => {
    const jobPayload = {
      report_id: "report-002940",
      status: "running",
      symbol: "002940.SZ",
      timeframe: "1d",
      as_of: "2026-08-13",
      input_digest: "digest-1",
      attempt_count: 1,
      updated_at: "2026-08-13T09:06:00+08:00",
      report: null,
      error: null,
      review_status: "pending",
      reviewed_at: null,
      published_at: null,
      share_token: null,
      outcome: null,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/reports/jobs")) {
        return jsonResponse([jobPayload]);
      }
      if (path === "/api/reports/quality?scope=all") {
        return jsonResponse({
          scope: "all",
          review: { accepted: 2, rejected: 1, decided: 3, accept_rate: "0.6667" },
          outcome: {
            evaluated: 4,
            conclusive: 2,
            realized: 1,
            none_realized: 1,
            ambiguous: 1,
            inconclusive: 0,
            pending: 1,
            realized_rate_over_conclusive: "0.5000",
            realized_rate_over_evaluated: "0.2500",
            by_case: { bullish: 1 },
          },
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = createHttpApi("");
    const jobs = await api.listInvestmentReportJobs({ latestPerSymbol: false });
    const quality = await api.getReportQuality("all");

    expect(fetchMock).toHaveBeenCalledWith("/api/reports/jobs?latest_per_symbol=false", expect.any(Object));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].symbol).toBe("002940.SZ");
    expect(quality).toEqual({
      scope: "all",
      review: { accepted: 2, rejected: 1, decided: 3, acceptRate: "0.6667" },
      outcome: {
        evaluated: 4,
        conclusive: 2,
        realized: 1,
        noneRealized: 1,
        ambiguous: 1,
        inconclusive: 0,
        pending: 1,
        realizedRateOverConclusive: "0.5000",
        realizedRateOverEvaluated: "0.2500",
        byCase: { bullish: 1 },
      },
    });
    expect(toReportQuality({
      scope: "published",
      review: { accepted: 0, rejected: 0, decided: 0, accept_rate: null },
      outcome: {
        evaluated: 0, conclusive: 0, realized: 0, none_realized: 0, ambiguous: 0,
        inconclusive: 0, pending: 0, realized_rate_over_conclusive: null,
        realized_rate_over_evaluated: null, by_case: {},
      },
    }).review.acceptRate).toBeNull();
  });

  it("runs mapPool with a concurrency cap", async () => {
    let inflight = 0;
    let peak = 0;
    const results = await mapPool([1, 2, 3, 4], 2, async (value) => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await Promise.resolve();
      inflight -= 1;
      return value * 2;
    });
    expect(results).toEqual([2, 4, 6, 8]);
    expect(peak).toBe(2);
  });

  it("maps the complete information DTO to camelCase", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(informationPayload()));
    vi.stubGlobal("fetch", fetchMock);

    const information = await createHttpApi("http://localhost:8000/").getInformation("002940.SZ");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/api/market/002940.SZ/information",
      expect.any(Object),
    );
    expect(information).toMatchObject({
      symbol: "002940.SZ",
      snapshotId: "information-1",
      generatedAt: "2026-08-13T09:00:00+08:00",
      news: [{ publishedAt: "2026-08-13T08:00:00+08:00", url: "https://example.com/news/1" }],
      messages: [{ answerer: "证券部", publishedAt: "2026-08-12T16:00:00+08:00" }],
      sentiment: { hotRank: 8, rankChange: 2, observedAt: "2026-08-13T09:00:00+08:00" },
      quality: { sources: { eastmoneyNews: { status: "fresh" }, cninfoIrm: { status: "cached" } } },
    });
  });

  it("clears non-http external URLs", async () => {
    const raw = informationPayload();
    raw.news[0].url = "javascript:alert(1)";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(raw)));

    const information = await createHttpApi("").getInformation("002940.SZ");

    expect(information.news[0].url).toBeNull();
  });

  it("rejects invalid required information timestamps as a 502 adapter error", async () => {
    const raw = informationPayload();
    raw.generated_at = "not-a-date";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(raw)));

    await expect(createHttpApi("").getInformation("002940.SZ")).rejects.toMatchObject({
      name: "ApiError",
      status: 502,
    });
  });

  it("creates an investment report with the selected timeframe", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ report_id: "report-1", status: "queued", cached: false }, 202));
    vi.stubGlobal("fetch", fetchMock);

    const created = await createHttpApi("").createInvestmentReport("002940.SZ", "1w");

    expect(created).toEqual({ reportId: "report-1", status: "queued", cached: false });
    expect(fetchMock).toHaveBeenCalledWith("/api/market/002940.SZ/reports", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ timeframe: "1w" }),
    }));
  });

  it("hydrates a completed report envelope without exposing raw draft text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(reportEnvelope())));

    const job = await createHttpApi("").getInvestmentReport("report-1");

    expect(job).toMatchObject({
      reportId: "report-1",
      status: "completed",
      inputDigest: "digest-1",
      attemptCount: 1,
      report: {
        schemaVersion: "investment_report.v2",
        generatedAt: "2026-08-13T09:05:00+08:00",
        review: { status: "pending" },
      },
    });
    expect(job.report?.outlook.scenarios[0]).toMatchObject({
      case: "bullish",
      trigger: { factRef: "market.latest_close", fact: { occurredAt: "2026-08-12T15:00:00+08:00" } },
      evidenceRefs: ["market.latest_close", "news.latest"],
    });
    expect(job.report).not.toHaveProperty("draft");
  });

  it("posts an empty body to the dedicated retry endpoint", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ report_id: "report-1", status: "queued", cached: false }, 202));
    vi.stubGlobal("fetch", fetchMock);

    const retried = await createHttpApi("").retryInvestmentReport("report-1");

    expect(retried).toEqual({ reportId: "report-1", status: "queued", cached: false });
    expect(fetchMock).toHaveBeenCalledWith("/api/reports/report-1/retry", expect.objectContaining({
      method: "POST",
      body: "{}",
    }));
  });

  it("extracts a safe message from nested backend errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      error: { code: "UPSTREAM_TIMEOUT", message: "上游生成超时", retryable: true },
    }, 503)));

    await expect(createHttpApi("").getInvestmentReport("report-1")).rejects.toEqual(
      new ApiError("上游生成超时", 503),
    );
  });

  it.each([
    ["queued with report", "queued", false, true],
    ["queued with error", "queued", true, false],
    ["running with report", "running", false, true],
    ["running with error", "running", true, false],
    ["completed with error", "completed", true, true],
    ["failed with report", "failed", true, true],
  ])("rejects an invalid %s state payload", (_name, status, withError, withReport) => {
    const raw = mutableReportEnvelope();
    raw.status = status;
    raw.report = withReport ? raw.report : null;
    raw.error = withError ? { code: "TIMEOUT", message: "超时", retryable: true } : null;

    expect(() => toInvestmentReportJob(raw)).toThrow(ApiError);
  });

  it.each([
    ["queued", null, null],
    ["running", null, null],
    ["failed", null, { code: "TIMEOUT", message: "超时", retryable: true }],
  ])("accepts the exact %s state payload", (status, report, error) => {
    const raw = mutableReportEnvelope();
    raw.status = status;
    raw.report = report;
    raw.error = error;

    expect(toInvestmentReportJob(raw).status).toBe(status);
  });

  it.each([
    ["report id", "report_id", "another-report"],
    ["symbol", "symbol", "600519.SH"],
    ["timeframe", "timeframe", "1d"],
    ["as-of date", "as_of", "2026-08-12"],
  ])("rejects an outer/inner %s mismatch", (_name, key, value) => {
    const raw = mutableReportEnvelope();
    raw[key] = value;

    expect(() => toInvestmentReportJob(raw)).toThrow(ApiError);
  });

  it("rejects a condition fact that differs from its canonical registry fact", () => {
    const raw = mutableReportEnvelope();
    const report = nestedRecord(raw.report);
    const outlook = nestedRecord(report.outlook);
    const scenario = nestedArray(outlook.scenarios)[0];
    const trigger = nestedRecord(scenario.trigger);
    trigger.fact = { ...nestedRecord(trigger.fact), value: "保证上涨" };

    expect(() => toInvestmentReportJob(raw)).toThrow(ApiError);
  });

  it("rejects an unknown condition reference even when the hydrated fact matches it", () => {
    const raw = mutableReportEnvelope();
    const report = nestedRecord(raw.report);
    const scenario = nestedArray(nestedRecord(report.outlook).scenarios)[0];
    const trigger = nestedRecord(scenario.trigger);
    trigger.fact_ref = "unknown.fact";
    trigger.fact = { ref: "unknown.fact", kind: "structure", label: "未知事实", value: "保证上涨" };

    expect(() => toInvestmentReportJob(raw)).toThrow(ApiError);
  });

  it.each(["top", "scenario", "risk"])("rejects %s evidence that differs from its canonical registry fact", (location) => {
    const raw = mutableReportEnvelope();
    const report = nestedRecord(raw.report);
    let owner = report;
    if (location === "scenario") owner = nestedArray(nestedRecord(report.outlook).scenarios)[0];
    if (location === "risk") owner = nestedArray(report.risks)[0];
    const evidence = nestedArray(owner.evidence);
    evidence[0] = { ...evidence[0], value: "保证上涨" };

    expect(() => toInvestmentReportJob(raw)).toThrow(ApiError);
  });

  it.each(["top", "scenario", "risk"])("rejects %s evidence refs that do not exactly match evidence order and length", (location) => {
    const raw = mutableReportEnvelope();
    const report = nestedRecord(raw.report);
    let owner = report;
    if (location === "scenario") owner = nestedArray(nestedRecord(report.outlook).scenarios)[0];
    if (location === "risk") owner = nestedArray(report.risks)[0];
    owner.evidence_refs = [...(owner.evidence_refs as string[])].reverse().concat("unknown.ref");

    expect(() => toInvestmentReportJob(raw)).toThrow(ApiError);
  });

  it("rejects unknown evidence even when the reference and hydrated fact match", () => {
    const raw = mutableReportEnvelope();
    const report = nestedRecord(raw.report);
    const refs = report.evidence_refs as string[];
    const evidence = nestedArray(report.evidence);
    refs[0] = "unknown.fact";
    evidence[0] = { ref: "unknown.fact", kind: "structure", label: "未知事实", value: "保证上涨" };

    expect(() => toInvestmentReportJob(raw)).toThrow(ApiError);
  });

  it("rejects duplicate hydrated evidence references", () => {
    const raw = mutableReportEnvelope();
    const report = nestedRecord(raw.report);
    const refs = report.evidence_refs as string[];
    const evidence = nestedArray(report.evidence);
    refs.push(refs[0]);
    evidence.push({ ...evidence[0] });

    expect(() => toInvestmentReportJob(raw)).toThrow(ApiError);
  });

  it("rejects a report disclaimer that differs from the fixed backend contract", () => {
    const raw = mutableReportEnvelope();
    nestedRecord(raw.report).disclaimer = "保证投资收益。";

    expect(() => toInvestmentReportJob(raw)).toThrow(ApiError);
  });

  it.each(["2026-02-30", "2026", "08/13/2026"])("rejects non-strict date %s", (generatedAt) => {
    const raw = informationPayload();
    raw.generated_at = generatedAt;

    expect(() => toStockInformation(raw)).toThrow(ApiError);
  });
});

describe("report delivery adapter", () => {
  it("maps review and publication state onto the job", () => {
    const raw = mutableReportEnvelope();
    raw.review_status = "accepted";
    raw.reviewed_at = "2026-08-13T10:00:00+08:00";
    raw.published_at = "2026-08-13T10:05:00+08:00";

    const job = toInvestmentReportJob(raw);

    expect(job.reviewStatus).toBe("accepted");
    expect(job.reviewedAt).toBe("2026-08-13T10:00:00+08:00");
    expect(job.publishedAt).toBe("2026-08-13T10:05:00+08:00");
  });

  it("rejects an unknown review status", () => {
    const raw = mutableReportEnvelope();
    raw.review_status = "approved";

    expect(() => toInvestmentReportJob(raw)).toThrow(ApiError);
  });

  it("maps an evaluated outcome including unevaluable conditions", () => {
    const outcome = toReportOutcome(outcomePayload());

    expect(outcome.status).toBe("realized");
    expect(outcome.adjudication).toBe("single_candidate");
    expect(outcome.realizedCase).toBe("bullish");
    expect(outcome.window).toEqual({ start: "20260814", end: "20260911", barCount: 20, requiredBars: 20 });
    expect(outcome.scenarios[0].trigger).toEqual({
      operator: "break_above",
      factRef: "market.recent_high",
      level: "21.00",
      hit: true,
      decisiveDate: "20260818",
      unevaluableReason: null,
    });
    expect(outcome.scenarios[0].invalidation.hit).toBeNull();
    expect(outcome.scenarios[0].invalidation.unevaluableReason).toBe("structure_condition_not_replayable");
  });

  it("carries the outcome through the report job envelope", () => {
    const raw = mutableReportEnvelope();
    raw.outcome = outcomePayload();

    expect(toInvestmentReportJob(raw).outcome?.realizedCase).toBe("bullish");
  });

  it("rejects an unknown outcome status", () => {
    const raw = outcomePayload() as Record<string, unknown>;
    raw.status = "partially_realized";

    expect(() => toReportOutcome(raw)).toThrow(ApiError);
  });

  it("maps a publication response", () => {
    const publication = toReportPublication({
      report_id: "report-1",
      review_status: "accepted",
      published_at: "2026-08-13T10:05:00+08:00",
    });

    expect(publication).toEqual({
      reportId: "report-1",
      reviewStatus: "accepted",
      publishedAt: "2026-08-13T10:05:00+08:00",
    });
  });

  it("carries the share token through the report job envelope", () => {
    const raw = mutableReportEnvelope();
    raw.share_token = "token-1";

    expect(toInvestmentReportJob(raw).shareToken).toBe("token-1");
  });
});

function sharedReportPayload() {
  const closeFact = { ref: "market.latest_close", kind: "price_level", label: "最新收盘", value: 20.6, unit: "CNY" };
  const structureFact = { ref: "chan.structure", kind: "structure", label: "当前结构", value: "中枢震荡" };
  const newsFact = { ref: "news.latest", kind: "news", label: "公司进展", value: "经营保持稳定", url: "https://example.com/news/1" };
  const scenarioInputs: Array<[string, string, string, typeof closeFact | typeof structureFact]> = [
    ["bullish", "结构确认后观察偏强情景。", "break_above", closeFact],
    ["base", "中枢约束下保持基准观察。", "structure_confirmed", structureFact],
    ["bearish", "结构失效后观察偏弱情景。", "break_below", closeFact],
  ];
  const scenarios = scenarioInputs.map(([scenarioCase, narrative, operator, fact]) => ({
    case: scenarioCase,
    narrative,
    trigger: { operator, fact_ref: fact.ref, fact },
    invalidation: { operator: "structure_invalidated", fact_ref: structureFact.ref, fact: structureFact },
    evidence_refs: [fact.ref, newsFact.ref],
    evidence: [fact, newsFact],
  }));
  return {
    symbol: "002940.SZ",
    timeframe: "1d",
    as_of: "2026-08-13",
    generated_at: "2026-08-13T09:05:00+08:00",
    published_at: "2026-08-14T09:00:00+08:00",
    title: "结构与资讯综合研判",
    executive_summary: "结构处于等待确认阶段。",
    outlook: {
      horizon: "5-20-trading-days",
      direction: "uncertain",
      confidence: "medium",
      thesis: "以后续结构确认与失效条件切换情景。",
      scenarios,
    },
    risks: [{ narrative: "资讯存在时效差异。", evidence_refs: [newsFact.ref], evidence: [newsFact] }],
    evidence: [closeFact, structureFact, newsFact],
    disclaimer: "本报告基于固化数据生成，仅供研究参考，不构成任何投资建议。",
    market_snapshot: {
      bars: [
        { occurred_at: "2026-08-11T00:00:00Z", open: "20", close: "20.2", low: "19.8", high: "20.5", volume: "90" },
        { occurred_at: "2026-08-12T00:00:00Z", open: "20.2", close: "20.6", low: "20.1", high: "21.0", volume: "100" },
      ],
      window: { start: "20260811", end: "20260812", bar_count: 2 },
      quality: { status: "ok", warnings: [] },
    },
    chan_analysis: {
      timeframe: "1d",
      snapshot: {
        bars: [{ occurred_at: "2026-08-11T00:00:00Z" }, { occurred_at: "2026-08-12T00:00:00Z" }],
        strokes: [],
        confirmed: [{ direction: "up", start_index: 0, end_index: 1, start_price: "19.8", end_price: "21.0" }],
        provisional: [],
        centers: [],
      },
    },
    outcome: {
      status: "realized",
      realized_case: "bullish",
      evaluated_at: "2026-09-10T09:00:00+08:00",
      window: { start: "20260813", end: "20260909", bar_count: 20, required_bars: 20 },
      quality: { status: "ok", warnings: ["示例告警"] },
    },
  };
}

describe("shared report adapter", () => {
  it("maps the sanitized shared view and rebuilds the chan chart", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(sharedReportPayload()));
    vi.stubGlobal("fetch", fetchMock);

    const shared = await createHttpApi("").getSharedReport("token-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/shared/token-1", expect.any(Object));
    expect(shared).toMatchObject({
      symbol: "002940.SZ",
      timeframe: "1d",
      publishedAt: "2026-08-14T09:00:00+08:00",
      title: "结构与资讯综合研判",
      outcome: {
        status: "realized",
        realizedCase: "bullish",
        window: { barCount: 20, requiredBars: 20 },
        quality: { warnings: ["示例告警"] },
      },
    });
    expect(shared.chart.bars).toHaveLength(2);
    expect(shared.chart.strokes[0]).toMatchObject({
      startAt: "2026-08-11T00:00:00Z",
      endAt: "2026-08-12T00:00:00Z",
      state: "confirmed",
    });
    expect(shared.outlook.scenarios[0]).toMatchObject({
      case: "bullish",
      trigger: { factRef: "market.latest_close", fact: { value: 20.6, unit: "CNY" } },
    });
    expect(shared.evidence.map((fact) => fact.ref)).toEqual([
      "market.latest_close", "chan.structure", "news.latest",
    ]);
  });

  it("rejects a shared payload that carries internal fields", () => {
    const raw = sharedReportPayload() as Record<string, unknown>;
    raw.input_digest = "digest-1";

    expect(() => toSharedReport(raw)).toThrow(ApiError);
  });

  it("rejects a tampered shared disclaimer", () => {
    const raw = sharedReportPayload() as Record<string, unknown>;
    raw.disclaimer = "保证投资收益。";

    expect(() => toSharedReport(raw)).toThrow(ApiError);
  });

  it("keeps the shared outcome optional", () => {
    const raw = sharedReportPayload() as Record<string, unknown>;
    raw.outcome = null;

    expect(toSharedReport(raw).outcome).toBeNull();
  });

  it("surfaces 404 for revoked or unknown share tokens", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ detail: "分享链接无效" }, 404)));

    await expect(createHttpApi("").getSharedReport("expired")).rejects.toEqual(
      new ApiError("分享链接无效", 404),
    );
  });

  it("creates and revokes a share link over http", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse(
          { report_id: "report-1", share_token: "token-1", share_url_path: "#/share/token-1" },
          201,
        );
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = createHttpApi("");

    const share = await api.createInvestmentReportShare("report-1");
    await api.revokeInvestmentReportShare("report-1");

    expect(share).toEqual({ reportId: "report-1", shareToken: "token-1", shareUrlPath: "#/share/token-1" });
    expect(fetchMock).toHaveBeenCalledWith("/api/reports/report-1/share", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/reports/report-1/share", expect.objectContaining({ method: "DELETE" }));
  });

  it("rejects a share path that does not match its token", () => {
    expect(() => toReportShare({
      report_id: "report-1",
      share_token: "token-1",
      share_url_path: "#/share/other",
    })).toThrow(ApiError);
  });
});
