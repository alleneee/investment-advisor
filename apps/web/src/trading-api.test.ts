import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createTradingApi } from "./trading-api";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
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
