import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createMockTradingApi, createTradingApi } from "./trading-api";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function periodSummaryResponse(returnCurve: unknown[]) {
  return {
    start: "2026-08-01",
    end: "2026-08-31",
    max_drawdown: "0.037500",
    return_curve: returnCurve,
  };
}

function metric(value: string | null, unavailableReason: string | null = null) {
  return { value, unavailable_reason: unavailableReason };
}

function bsSymbol(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "002041.SZ",
    name: "登海种业",
    realized_pnl: "4377.88",
    period_pnl: "4377.88",
    closed_cycle_count: 2,
    median_holding_days: metric("13"),
    win_rate: metric("1"),
    ...overrides,
  };
}

function bsSummary(overrides: Record<string, unknown> = {}) {
  return {
    start: "2026-08-01",
    end: "2026-08-31",
    symbols: [bsSymbol()],
    ...overrides,
  };
}

function chartBar(overrides: Record<string, unknown> = {}) {
  return {
    trade_date: "2026-08-10",
    occurred_at: "2026-08-10T00:00:00+08:00",
    open: "10",
    high: "11",
    low: "9",
    close: "10.5",
    volume: "1000",
    ...overrides,
  };
}

function chartExecution(overrides: Record<string, unknown> = {}) {
  return {
    execution_id: "execution-1",
    symbol: "600000.SH",
    side: "buy",
    price: "10.5",
    quantity: 100,
    fee: "0",
    primary_reason: "pullback_confirmation",
    occurred_at: "2026-08-10T10:00:00+08:00",
    bar_occurred_at: "2026-08-10T00:00:00+08:00",
    ...overrides,
  };
}

function bsChart(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "600000.SH",
    timeframe: "1d",
    available: true,
    adjustment: "none",
    bars: [chartBar()],
    executions: [chartExecution()],
    macd: { ready: false, dif: [], dea: [], histogram: [] },
    quality: { status: "ok", warnings: [] },
    ...overrides,
  };
}

function chartMark(overrides: Record<string, unknown> = {}) {
  return {
    mark_id: "mark-1",
    account_id: "account-1",
    symbol: "600000.SH",
    occurred_at: "2026-08-10T00:00:00+08:00",
    type_id: "type-1",
    comment: "理想买",
    revision: 1,
    created_at: "2026-08-10T10:00:00+08:00",
    updated_at: "2026-08-10T10:00:00+08:00",
    ...overrides,
  };
}

function chartMarkType(overrides: Record<string, unknown> = {}) {
  return {
    type_id: "type-1",
    account_id: "account-1",
    code: "ideal_buy",
    label: "理想买",
    letter: "买",
    color: "#f6465d",
    preset: true,
    enabled: true,
    created_at: "2026-08-01T00:00:00+08:00",
    ...overrides,
  };
}

function reasonPerformance(overrides: Record<string, unknown> = {}) {
  return {
    side: "buy",
    reason_code: "pullback_confirmation",
    sample_count: 1,
    conclusion_allowed: false,
    win_rate: metric("1"),
    net_pnl: "2",
    average_cycle_return_rate: metric("0.02"),
    median_holding_days: metric("1"),
    max_cycle_profit: metric("2"),
    max_cycle_loss: metric(null, "no_losing_cycle"),
    ...overrides,
  };
}

function deterministicReport(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "deterministic_trading_review.v1",
    sample: {
      trading_day_count: 1,
      execution_count: 2,
      closed_cycle_count: 1,
      overall_conclusion_allowed: false,
    },
    metrics: {
      period_realized_pnl: "2",
      closed_cycle_pnl: "2",
      account_adjusted_return_rate: metric("0.02"),
      period_max_drawdown_rate: metric("0"),
      win_rate: metric("1"),
      average_win_loss_ratio: metric(null, "no_losing_cycle"),
      profit_factor: metric(null, "no_losing_cycle"),
      median_holding_days: metric("1"),
      median_capital_efficiency: metric("0.02"),
      discipline_adherence_rate: metric("1"),
    },
    equity_curve: [],
    execution_reason_facts: [],
    reason_performance: [reasonPerformance()],
    cycle_cases: [],
    comparison: null,
    comparison_unavailable_reason: "partial_period",
    chart_bundles: [],
    quality: { warnings: [] },
    ...overrides,
  };
}

function previewReview(overrides: Record<string, unknown> = {}) {
  return {
    period_kind: "month",
    period_start: "2026-08-01",
    period_end: "2026-08-31",
    partial_period: true,
    data_quality: "ok",
    input_digest: "digest-1",
    ledger_revision: 1,
    daily_review_revision: 1,
    market_revision: 1,
    market_watermark: "market-1",
    deterministic_report: deterministicReport(),
    error: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("trading API", () => {
  it("reads the account summary without converting financial decimal text to numbers", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      account_id: "account-1",
      name: "主账户",
      activated_on: "2026-08-01",
      initial_capital: "100000.00",
      ledger_revision: 3,
      cash: "74530.50",
      position_market_value: "25820.00",
      total_equity: "100350.50",
      valuation_date: "2026-08-17",
      daily_pnl: "350.50",
      since_inception_drawdown: "0.0325",
      data_quality: "ok",
      data_quality_warnings: [],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const account = await createTradingApi("").getAccount();

    expect(fetchMock).toHaveBeenCalledWith("/api/trading/account", expect.anything());
    expect(account).toMatchObject({
      accountId: "account-1",
      cash: "74530.50",
      totalEquity: "100350.50",
      sinceInceptionDrawdown: "0.0325",
    });
  });

  it("parses the structure attribution report and keeps decimal text untouched", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      summary: [{
        category: "inside_center",
        closed_cycles: 1,
        open_cycles: 1,
        won: 1,
        win_rate: "1",
        total_pnl: "200",
        avg_pnl: "200.00",
      }],
      executions: [{
        execution_id: "execution-1",
        symbol: "600156.SH",
        trade_date: "2026-08-11",
        executed_at: "2026-08-11T10:00:00+08:00",
        side: "buy",
        price: "21.6",
        quantity: 100,
        adjusted_price: "10.8",
        center_lower: "7.5",
        center_upper: "10.8",
        category: "inside_center",
        reason: null,
      }],
      quality: { unclassified_executions: [], symbols_missing_market_data: [] },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const attribution = await createTradingApi("").getStructureAttribution();

    expect(fetchMock).toHaveBeenCalledWith("/api/trading/structure-attribution", expect.anything());
    expect(attribution.summary[0]).toMatchObject({ category: "inside_center", winRate: "1", avgPnl: "200.00" });
    expect(attribution.executions[0]).toMatchObject({ adjustedPrice: "10.8", centerLower: "7.5", centerUpper: "10.8" });
  });

  it("reads the monthly trading calendar without converting decimal text", async () => {
    const days = Array.from({ length: 31 }, (_, index) => {
      const date = `2026-01-${String(index + 1).padStart(2, "0")}`;
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
      return {
        date,
        execution_count: index === 9 ? 2 : 0,
        daily_pnl: index === 9 ? "1250.50" : null,
        review_status: index === 9 ? "draft" : null,
        is_open: weekday !== 0 && weekday !== 6,
      };
    });
    const fetchMock = vi.fn(async () => jsonResponse({
      month: "2026-01",
      net_pnl: "1250.50",
      max_drawdown: "0.0375",
      days,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const calendar = await createTradingApi("").getCalendar("2026-01");

    expect(fetchMock).toHaveBeenCalledWith("/api/trading/calendar?month=2026-01", expect.anything());
    expect(calendar).toMatchObject({
      month: "2026-01",
      netPnl: "1250.50",
      maxDrawdown: "0.0375",
      days: expect.arrayContaining([{
        date: "2026-01-10",
        executionCount: 2,
        dailyPnl: "1250.50",
        reviewStatus: "draft",
        isOpen: false,
      }]),
    });
    expect(calendar.days).toHaveLength(31);
  });

  it("reads the period return curve without converting decimal text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(periodSummaryResponse([
      {
        date: "2026-08-01",
        cumulative_return_rate: { value: "0.000000", unavailable_reason: null },
      },
      {
        date: "2026-08-04",
        cumulative_return_rate: { value: null, unavailable_reason: "valuation_unavailable" },
      },
    ]))));

    const summary = await createTradingApi("").getPeriodSummary("2026-08-01", "2026-08-31");

    expect(summary).toEqual({
      start: "2026-08-01",
      end: "2026-08-31",
      maxDrawdown: "0.037500",
      returnCurve: [
        {
          date: "2026-08-01",
          cumulativeReturnRate: { value: "0.000000", unavailableReason: null },
        },
        {
          date: "2026-08-04",
          cumulativeReturnRate: { value: null, unavailableReason: "valuation_unavailable" },
        },
      ],
    });
  });

  it("rejects a period summary whose boundaries differ from the request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      ...periodSummaryResponse([]),
      start: "2026-08-02",
    })));

    await expect(createTradingApi("").getPeriodSummary("2026-08-01", "2026-08-31"))
      .rejects.toThrow("周期摘要边界与请求不一致");
  });

  it("rejects a period return metric with inconsistent availability state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(periodSummaryResponse([
      {
        date: "2026-08-01",
        cumulative_return_rate: { value: null, unavailable_reason: null },
      },
    ]))));

    await expect(createTradingApi("").getPeriodSummary("2026-08-01", "2026-08-31"))
      .rejects.toThrow("周期累计收益率 1状态不一致");
  });

  it("rejects a period return curve date outside the summary range", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(periodSummaryResponse([
      {
        date: "2026-09-01",
        cumulative_return_rate: { value: "0.01", unavailable_reason: null },
      },
    ]))));

    await expect(createTradingApi("").getPeriodSummary("2026-08-01", "2026-08-31"))
      .rejects.toThrow("周期收益曲线日期超出周期范围");
  });

  it("rejects duplicate or non-ascending period return curve dates", async () => {
    for (const dates of [
      ["2026-08-01", "2026-08-01"],
      ["2026-08-02", "2026-08-01"],
    ]) {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(periodSummaryResponse(dates.map((date) => ({
        date,
        cumulative_return_rate: { value: "0.01", unavailable_reason: null },
      }))))));

      await expect(createTradingApi("").getPeriodSummary("2026-08-01", "2026-08-31"))
        .rejects.toThrow("周期收益曲线日期必须严格升序");
    }
  });

  it("turns a missing account into the onboarding state but preserves other failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      status: "failed",
      error: { code: "ACCOUNT_NOT_FOUND", message: "交易账户不存在" },
      retryable: false,
    }, 404)));

    await expect(createTradingApi("").getAccount()).resolves.toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      status: "failed",
      error: { code: "INTERNAL_ERROR", message: "服务暂不可用" },
      retryable: true,
    }, 500)));
    await expect(createTradingApi("").getAccount()).rejects.toBeInstanceOf(ApiError);
  });

  it("parses BS summary decimals and nullable win rate without converting them to numbers", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(bsSummary({
      symbols: [
        bsSymbol(),
        bsSymbol({
          symbol: "000001.SZ",
          name: "平安银行",
          realized_pnl: "0.00",
          period_pnl: "0.00",
          closed_cycle_count: 0,
          median_holding_days: metric(null, "no_closed_cycle"),
          win_rate: metric(null, "no_closed_cycle"),
        }),
      ],
    })));
    vi.stubGlobal("fetch", fetchMock);

    const summary = await createTradingApi("").getBsSummary("2026-08-01", "2026-08-31");

    expect(fetchMock).toHaveBeenCalledWith("/api/trading/bs-summary?start=2026-08-01&end=2026-08-31", expect.anything());
    expect(summary).toEqual({
      start: "2026-08-01",
      end: "2026-08-31",
      symbols: [
        {
          symbol: "002041.SZ",
          name: "登海种业",
          realizedPnl: "4377.88",
          periodPnl: "4377.88",
          closedCycleCount: 2,
          medianHoldingDays: { value: "13", unavailableReason: null },
          winRate: { value: "1", unavailableReason: null },
        },
        {
          symbol: "000001.SZ",
          name: "平安银行",
          realizedPnl: "0.00",
          periodPnl: "0.00",
          closedCycleCount: 0,
          medianHoldingDays: { value: null, unavailableReason: "no_closed_cycle" },
          winRate: { value: null, unavailableReason: "no_closed_cycle" },
        },
      ],
    });
  });

  it("rejects a BS summary whose boundaries differ from the request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(bsSummary({ start: "2026-08-02" }))));

    await expect(createTradingApi("").getBsSummary("2026-08-01", "2026-08-31"))
      .rejects.toThrow("BS 摘要边界与请求不一致");
  });

  it("rejects a BS summary with extra or missing fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ...bsSummary(), extra: true })));
    await expect(createTradingApi("").getBsSummary("2026-08-01", "2026-08-31"))
      .rejects.toThrow("BS 摘要字段无效");

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      ...bsSummary(),
      symbols: [{ ...bsSymbol(), realized_pnl: 4377.88 }],
    })));
    await expect(createTradingApi("").getBsSummary("2026-08-01", "2026-08-31"))
      .rejects.toThrow("个股已实现盈亏无效");
  });

  it("parses a BS chart, keeps adjustment none, and requires executions", async () => {
    const bars = [chartBar(), chartBar({ trade_date: "2026-08-11", occurred_at: "2026-08-11T00:00:00+08:00", close: "10.8" })];
    const fetchMock = vi.fn(async () => jsonResponse(bsChart({
      bars,
      macd: {
        ready: true,
        warmup_bars: 26,
        dif: ["0.1", "0.2"],
        dea: ["0.05", "0.1"],
        histogram: ["0.1", "0.2"],
      },
    })));
    vi.stubGlobal("fetch", fetchMock);

    const chart = await createTradingApi("").getBsChart("600000.SH", "1d", "2026-08-01", "2026-08-31");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trading/bs-chart?symbol=600000.SH&timeframe=1d&start=2026-08-01&end=2026-08-31",
      expect.anything(),
    );
    expect(chart.adjustment).toBe("none");
    expect(chart.executions[0]).toMatchObject({
      executionId: "execution-1",
      occurredAt: "2026-08-10T10:00:00+08:00",
      barOccurredAt: "2026-08-10T00:00:00+08:00",
      price: "10.5",
    });
    expect(chart.macd).toMatchObject({
      ready: true,
      dif: ["0.1", "0.2"],
      dea: ["0.05", "0.1"],
      histogram: ["0.1", "0.2"],
    });
  });

  it("parses an unavailable BS chart with empty MACD series", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(bsChart({
      timeframe: "30m",
      available: false,
      bars: [],
      executions: [],
      macd: { ready: false, dif: [], dea: [], histogram: [] },
      quality: { status: "unavailable", warnings: ["stk_mins failed"] },
    }))));

    const chart = await createTradingApi("").getBsChart("600000.SH", "30m", "2026-08-01", "2026-08-31");

    expect(chart.available).toBe(false);
    expect(chart.bars).toEqual([]);
    expect(chart.executions).toEqual([]);
    expect(chart.macd).toEqual({ ready: false, dif: [], dea: [], histogram: [] });
    expect(chart.quality).toEqual({ status: "unavailable", warnings: ["stk_mins failed"] });
  });

  it("rejects a BS chart that omits executions", async () => {
    const { executions: _executions, ...withoutExecutions } = bsChart();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(withoutExecutions)));

    await expect(createTradingApi("").getBsChart("600000.SH", "1d", "2026-08-01", "2026-08-31"))
      .rejects.toBeInstanceOf(ApiError);
  });

  it("rejects a BS chart whose MACD series length is neither empty nor bars.length", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(bsChart({
      macd: { ready: true, warmup_bars: 26, dif: ["0.1", "0.2"], dea: ["0.1"], histogram: ["0.1"] },
    }))));

    await expect(createTradingApi("").getBsChart("600000.SH", "1d", "2026-08-01", "2026-08-31"))
      .rejects.toThrow("MACD 序列长度无效");
  });

  it("rejects scientific-notation MACD values that the exact-decimal contract forbids", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(bsChart({
      macd: { ready: true, warmup_bars: 26, dif: ["0"], dea: ["0"], histogram: ["0E-26"] },
    }))));

    await expect(createTradingApi("").getBsChart("600000.SH", "1d", "2026-08-01", "2026-08-31"))
      .rejects.toThrow("MACD 柱 1无效");
  });

  it("parses a ready MACD whose warmup zeros are plain 0", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(bsChart({
      macd: { ready: true, warmup_bars: 26, dif: ["0"], dea: ["0"], histogram: ["0"] },
    }))));

    const chart = await createTradingApi("").getBsChart("600000.SH", "1d", "2026-08-01", "2026-08-31");
    expect(chart.macd).toMatchObject({ ready: true, dif: ["0"], dea: ["0"], histogram: ["0"] });
  });

  it("rejects a BS chart with an unknown field or a non-none adjustment", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ...bsChart(), extra: true })));
    await expect(createTradingApi("").getBsChart("600000.SH", "1d", "2026-08-01", "2026-08-31"))
      .rejects.toThrow("BS 图表字段无效");

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(bsChart({ adjustment: "qfq" }))));
    await expect(createTradingApi("").getBsChart("600000.SH", "1d", "2026-08-01", "2026-08-31"))
      .rejects.toThrow("BS 图表复权方式无效");
  });

  it("lists chart marks covering the chart window and keeps comment as a string", async () => {
    const fetchMock = vi.fn(async () => jsonResponse([chartMark({ comment: "" })]));
    vi.stubGlobal("fetch", fetchMock);

    const marks = await createTradingApi("").listChartMarks("600000.SH", "2025-07-05", "2026-08-31");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trading/chart-marks?symbol=600000.SH&start=2025-07-05&end=2026-08-31",
      expect.anything(),
    );
    expect(marks[0]).toMatchObject({
      markId: "mark-1",
      occurredAt: "2026-08-10T00:00:00+08:00",
      comment: "",
      typeId: "type-1",
    });
  });

  it("rejects a chart mark with an invalid occurredAt or extra fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([chartMark({ occurred_at: "2026-08-10 00:00:00" })])));
    await expect(createTradingApi("").listChartMarks("600000.SH", "2026-08-01", "2026-08-31"))
      .rejects.toThrow("手标 1时间无效");

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([chartMark({ extra: true })])));
    await expect(createTradingApi("").listChartMarks("600000.SH", "2026-08-01", "2026-08-31"))
      .rejects.toThrow("手标 1字段无效");
  });

  it("creates a chart mark with snake_case JSON and parses the response", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(chartMark(), 201));
    vi.stubGlobal("fetch", fetchMock);

    const mark = await createTradingApi("").createChartMark({
      symbol: "600000.SH",
      occurredAt: "2026-08-10T00:00:00+08:00",
      typeId: "type-1",
      comment: "理想买",
      timeframe: "1d",
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/trading/chart-marks", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        symbol: "600000.SH",
        occurred_at: "2026-08-10T00:00:00+08:00",
        type_id: "type-1",
        comment: "理想买",
        timeframe: "1d",
      }),
    }));
    expect(mark.markId).toBe("mark-1");
  });

  it("parses chart mark types and posts only label, letter, and color when creating", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      if (typeof input === "string" && input.endsWith("/chart-mark-types") && init?.method === "POST") {
        return jsonResponse(chartMarkType({ type_id: "type-2", code: "custom_abc", preset: false, label: "突破", letter: "突", color: "#123456" }), 201);
      }
      return jsonResponse([chartMarkType()]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const listed = await createTradingApi("").listChartMarkTypes();
    const created = await createTradingApi("").createChartMarkType({ label: "突破", letter: "突", color: "#123456" });

    expect(listed[0]).toMatchObject({ typeId: "type-1", code: "ideal_buy", preset: true, letter: "买" });
    expect(fetchMock).toHaveBeenCalledWith("/api/trading/chart-mark-types", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ label: "突破", letter: "突", color: "#123456" }),
    }));
    expect(created).toMatchObject({ typeId: "type-2", preset: false, label: "突破" });
  });

  it("parses preview reason_performance max cycle profit and loss without converting decimal text", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(previewReview({
      deterministic_report: deterministicReport({
        reason_performance: [reasonPerformance({
          max_cycle_profit: metric("2"),
          max_cycle_loss: metric(null, "no_losing_cycle"),
        })],
      }),
    })));
    vi.stubGlobal("fetch", fetchMock);

    const report = await createTradingApi("").getReviewPreview("month", "2026-08-01", "2026-08-31");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trading/reviews/preview?period_kind=month&start=2026-08-01&end=2026-08-31",
      expect.anything(),
    );
    expect(report.deterministicReport?.reasonPerformance).toEqual([{
      side: "buy",
      reasonCode: "pullback_confirmation",
      sampleCount: 1,
      conclusionAllowed: false,
      winRate: { value: "1", unavailableReason: null },
      netPnl: "2",
      averageCycleReturnRate: { value: "0.02", unavailableReason: null },
      medianHoldingDays: { value: "1", unavailableReason: null },
      maxCycleProfit: { value: "2", unavailableReason: null },
      maxCycleLoss: { value: null, unavailableReason: "no_losing_cycle" },
    }]);
  });

  it("createMockTradingApi implements BS methods with empty data instead of 503", async () => {
    const api = createMockTradingApi();
    await expect(api.getBsSummary("2026-08-01", "2026-08-31")).resolves.toEqual({
      start: "2026-08-01",
      end: "2026-08-31",
      symbols: [],
    });
    await expect(api.getBsChart("600000.SH", "1d", "2026-08-01", "2026-08-31")).resolves.toMatchObject({
      available: false,
      adjustment: "none",
      bars: [],
      executions: [],
      macd: { ready: false, dif: [], dea: [], histogram: [] },
    });
    await expect(api.listChartMarks("600000.SH", "2026-08-01", "2026-08-31")).resolves.toEqual([]);
    await expect(api.listChartMarkTypes()).resolves.toEqual([]);
  });
});
