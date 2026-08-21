import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TradeJournalPage } from "./TradeJournalPage";
import type { TradingAccount, TradingExecution } from "./trading-types";
import type { TradingApi } from "./trading-api";

const account: TradingAccount = {
  accountId: "account-1",
  name: "主账户",
  activatedOn: "2026-08-01",
  initialCapital: "100000.00",
  ledgerRevision: 0,
  cash: "100000",
  positionMarketValue: "0.00",
  totalEquity: "100000.00",
  valuationDate: "2026-08-17",
  dailyPnl: "0.00",
  sinceInceptionDrawdown: "0",
  dataQuality: "ok",
  dataQualityWarnings: [],
};

function apiForJournal(overrides: Partial<TradingApi> = {}): TradingApi {
  return {
    getAccount: vi.fn(async () => null),
    createAccount: vi.fn(async () => account),
    listExecutions: vi.fn(async () => []),
    createExecution: vi.fn(),
    updateExecution: vi.fn(),
    deleteExecution: vi.fn(),
    listCashFlows: vi.fn(async () => []),
    createCashFlow: vi.fn(),
    deleteCashFlow: vi.fn(),
    getDailyReview: vi.fn(async () => null),
    saveDailyReview: vi.fn(),
    getStructureAttribution: vi.fn(),
    getReviewPreview: vi.fn(),
    createReviewReport: vi.fn(),
    listReviewReports: vi.fn(),
    getReviewReport: vi.fn(),
    retryReviewReport: vi.fn(),
    ...overrides,
  };
}

describe("交易日记", () => {
  it("在没有账户时创建唯一账户并进入每日工作台", async () => {
    const user = userEvent.setup();
    const api = apiForJournal();
    render(<TradeJournalPage api={api} today="2026-08-17" />);

    expect(await screen.findByRole("heading", { name: "创建交易账户" })).toBeInTheDocument();
    await user.clear(screen.getByLabelText("账户名称"));
    await user.type(screen.getByLabelText("账户名称"), "我的交易账户");
    await user.clear(screen.getByLabelText("初始资金"));
    await user.type(screen.getByLabelText("初始资金"), "120000.00");
    await user.click(screen.getByRole("button", { name: "创建并进入日记" }));

    await waitFor(() => expect(api.createAccount).toHaveBeenCalledWith({
      name: "我的交易账户",
      activatedOn: "2026-08-17",
      initialCapital: "120000.00",
    }));
    expect(await screen.findByRole("heading", { name: "每日交易日记" })).toBeInTheDocument();
    expect(screen.getByText("100000.00")).toBeInTheDocument();
  });

  it("随买卖方向切换理由，并保存成交后刷新当日流水", async () => {
    const user = userEvent.setup();
    const saved: TradingExecution = {
      executionId: "execution-1",
      symbol: "002940.SZ",
      name: "昂利康",
      executedAt: "2026-08-17T14:30:00+08:00",
      side: "buy",
      price: "20.15",
      quantity: 100,
      fee: "5.00",
      primaryReason: "pullback_confirmation",
      tags: ["计划内"],
      note: "回踩确认",
      clientIdempotencyKey: "11111111-1111-4111-8111-111111111111",
      revision: 1,
      ledgerRevision: 1,
    };
    const createExecution = vi.fn(async () => saved);
    const listExecutions = vi.fn(async () => [saved]);
    const api = apiForJournal({
      getAccount: vi.fn(async () => account),
      createExecution,
      listExecutions,
    });
    render(<TradeJournalPage api={api} today="2026-08-17" />);

    expect(await screen.findByRole("heading", { name: "每日交易日记" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "回踩确认" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("方向"), "sell");
    expect(screen.getByRole("option", { name: "止损" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("方向"), "buy");
    await user.type(screen.getByLabelText("股票代码"), "002940.SZ");
    await user.type(screen.getByLabelText("股票名称"), "昂利康");
    await user.clear(screen.getByLabelText("成交价格"));
    await user.type(screen.getByLabelText("成交价格"), "20.15");
    await user.clear(screen.getByLabelText("成交股数"));
    await user.type(screen.getByLabelText("成交股数"), "100");
    await user.type(screen.getByLabelText("辅助标签"), "计划内");
    await user.type(screen.getByLabelText("成交备注"), "回踩确认");
    await user.click(screen.getByRole("button", { name: "保存成交" }));

    await waitFor(() => expect(createExecution).toHaveBeenCalledWith(expect.objectContaining({
      symbol: "002940.SZ",
      name: "昂利康",
      side: "buy",
      price: "20.15",
      quantity: 100,
      primaryReason: "pullback_confirmation",
      tags: ["计划内"],
      note: "回踩确认",
    })));
    expect(await screen.findByText("002940.SZ")).toBeInTheDocument();
    expect(listExecutions).toHaveBeenCalledWith("2026-08-17");
  });
});
