import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createTradingApi } from "./trading-api";

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
});
