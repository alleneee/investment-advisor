import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TradeJournalPage } from "./TradeJournalPage";
import type { ReviewPeriodKind, TradingAccount, TradingCalendarMonth, TradingExecution, TradingPeriodSummary } from "./trading-types";
import type { TradingApi } from "./trading-api";

const { journalReturnChartRender } = vi.hoisted(() => ({ journalReturnChartRender: vi.fn() }));

vi.mock("./TradingReviewChart", () => ({
  TradingReviewChart: ({ bundle }: { bundle: { symbol: string } }) => <div role="img" aria-label={`${bundle.symbol} 交易复盘图`} />,
}));

vi.mock("./JournalReturnChart", () => ({
  JournalReturnChart: (props: { periodKind: ReviewPeriodKind; summary: TradingPeriodSummary | undefined }) => {
    journalReturnChartRender(props);
    return <div role="img" aria-label={`收益图 ${props.periodKind} ${props.summary ? `${props.summary.start} ${props.summary.end}` : "loading"}`} />;
  },
}));

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

function emptyCalendar(month: string): TradingCalendarMonth {
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
  return {
    month,
    netPnl: null,
    maxDrawdown: null,
    days: Array.from({ length: last }, (_, index) => {
      const date = `${month}-${String(index + 1).padStart(2, "0")}`;
      return {
        date,
        executionCount: 0,
        dailyPnl: null,
        reviewStatus: null,
        isOpen: new Date(`${date}T12:00:00Z`).getUTCDay() % 6 !== 0,
      };
    }),
  };
}

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
    getCalendar: vi.fn(async (month: string) => emptyCalendar(month)),
    getPeriodSummary: vi.fn(async (start: string, end: string) => ({ start, end, maxDrawdown: null, returnCurve: [] })),
    getStructureAttribution: vi.fn(async () => ({
      summary: [],
      executions: [],
      quality: { unclassifiedExecutions: [], symbolsMissingMarketData: [] },
    })),
    getReviewPreview: vi.fn(),
    createReviewReport: vi.fn(),
    listReviewReports: vi.fn(async () => []),
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
    expect(await screen.findByRole("heading", { name: "2026年8月" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "月视图" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("100,000.00")).toBeInTheDocument();
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

    expect(await screen.findByRole("heading", { name: "2026年8月" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "列表视图" }));
    expect(await screen.findByRole("heading", { name: "每日交易日志" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "回踩确认" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("方向"), "sell");
    expect(screen.getByRole("option", { name: "止损" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("方向"), "buy");
    await user.type(screen.getByLabelText("代码"), "002940.SZ");
    await user.type(screen.getByLabelText("资产名称"), "昂利康");
    await user.clear(screen.getByLabelText("成交价"));
    await user.type(screen.getByLabelText("成交价"), "20.15");
    await user.clear(screen.getByLabelText("份额/数量"));
    await user.type(screen.getByLabelText("份额/数量"), "100");
    await user.type(screen.getByLabelText("附加标签 (以逗号分隔)"), "计划内");
    await user.type(screen.getByLabelText("成交备注"), "回踩确认");
    await user.click(screen.getByRole("button", { name: "保存交易记录" }));

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

  it("月视图按日展示成交笔数，点击日期后侧栏显示当日流水", async () => {
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
    const august = emptyCalendar("2026-08");
    august.netPnl = "350.50";
    august.days[16] = { date: "2026-08-17", executionCount: 1, dailyPnl: "350.50", reviewStatus: "draft", isOpen: true };
    const getCalendar = vi.fn(async (month: string) => month === "2026-08" ? august : emptyCalendar(month));
    const api = apiForJournal({
      getAccount: vi.fn(async () => account),
      getCalendar,
      listExecutions: vi.fn(async (date: string) => date === "2026-08-17" ? [saved] : []),
    });
    render(<TradeJournalPage api={api} today="2026-08-17" />);

    expect(await screen.findByRole("heading", { name: "2026年8月" })).toBeInTheDocument();
    await waitFor(() => expect(getCalendar).toHaveBeenCalledWith("2026-08"));
    const gains = screen.getAllByText("+350.50");
    expect(gains.length).toBeGreaterThan(0);
    expect(gains.some((node) => node.className.includes("tone-gain"))).toBe(true);
    expect(screen.getByRole("button", { name: /2026年8月17日，1 笔成交/ })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "上个月" }));
    expect(getCalendar).toHaveBeenCalledWith("2026-07");
    expect(await screen.findByRole("heading", { name: "2026年7月" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "下个月" }));
    expect(await screen.findByRole("heading", { name: "2026年8月" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /2026年8月17日，1 笔成交/ }));
    expect(await screen.findByText("002940.SZ")).toBeInTheDocument();
    expect(screen.getByText("草稿")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "记录当日成交" }));
    expect(await screen.findByRole("heading", { name: "每日交易日志" })).toBeInTheDocument();
    expect(screen.getByLabelText("方向")).toBeInTheDocument();
  });

  it("月视图最大回撤用当月而不是成立以来", async () => {
    const august = emptyCalendar("2026-08");
    august.maxDrawdown = "0.0375";
    const api = apiForJournal({
      getAccount: vi.fn(async () => ({ ...account, sinceInceptionDrawdown: "0.3228" })),
      getCalendar: vi.fn(async (month: string) => month === "2026-08" ? august : emptyCalendar(month)),
    });
    render(<TradeJournalPage api={api} today="2026-08-17" />);

    expect(await screen.findByRole("grid", { name: "交易月历" })).toBeInTheDocument();
    expect(screen.getByText("本月最大回撤")).toBeInTheDocument();
    expect(screen.getByText("3.75%")).toBeInTheDocument();
    expect(screen.queryByText("32.28%")).not.toBeInTheDocument();
  });

  it("周季年视图最大回撤用当前周期而不是成立以来", async () => {
    const user = userEvent.setup();
    const getPeriodSummary = vi.fn(async (start: string, end: string) => {
      if (start === "2026-08-17") return { start, end, maxDrawdown: "0.0123", returnCurve: [] };
      if (start === "2026-07-01") return { start, end, maxDrawdown: "0.0456", returnCurve: [] };
      if (start === "2026-01-01") return { start, end, maxDrawdown: "0.0789", returnCurve: [] };
      return { start, end, maxDrawdown: null, returnCurve: [] };
    });
    const api = apiForJournal({
      getAccount: vi.fn(async () => ({ ...account, sinceInceptionDrawdown: "0.3228" })),
      getPeriodSummary,
    });
    render(<TradeJournalPage api={api} today="2026-08-17" />);

    expect(await screen.findByRole("heading", { name: "2026年8月" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "周视图" }));
    expect(await screen.findByText("本周最大回撤")).toBeInTheDocument();
    expect(await screen.findByText("1.23%")).toBeInTheDocument();
    expect(getPeriodSummary).toHaveBeenCalledWith("2026-08-17", "2026-08-21");
    expect(screen.queryByText("32.28%")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "季报" }));
    expect(await screen.findByText("本季最大回撤")).toBeInTheDocument();
    expect(await screen.findByText("4.56%")).toBeInTheDocument();
    expect(getPeriodSummary).toHaveBeenCalledWith("2026-07-01", "2026-09-30");
    expect(screen.queryByText("32.28%")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "年报" }));
    expect(await screen.findByText("本年最大回撤")).toBeInTheDocument();
    expect(await screen.findByText("7.89%")).toBeInTheDocument();
    expect(getPeriodSummary).toHaveBeenCalledWith("2026-01-01", "2026-12-31");
    expect(screen.queryByText("32.28%")).not.toBeInTheDocument();
  });

  it("月历和周历只保留交易日", async () => {
    const user = userEvent.setup();
    const august = emptyCalendar("2026-08");
    august.days[2] = { ...august.days[2], isOpen: false };
    const api = apiForJournal({
      getAccount: vi.fn(async () => account),
      getCalendar: vi.fn(async (month: string) => month === "2026-08" ? august : emptyCalendar(month)),
    });
    render(<TradeJournalPage api={api} today="2026-08-17" />);

    expect(await screen.findByRole("grid", { name: "交易月历" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /2026年8月1日/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /2026年8月2日/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /2026年8月3日/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /2026年8月4日/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /2026年8月17日/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "周视图" }));
    expect(await screen.findByRole("grid", { name: "交易周历" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /2026年8月17日/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /2026年8月21日/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /2026年8月22日/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /2026年8月23日/ })).not.toBeInTheDocument();
  });

  it("日记盈亏用红涨绿跌配色", async () => {
    const { readFileSync } = await import("node:fs");
    const { cwd } = await import("node:process");
    const styles = readFileSync(`${cwd()}/src/styles.css`, "utf8");
    expect(styles).toMatch(/\.trade-journal-page \.tone-gain \{ color: var\(--up\)/);
    expect(styles).toMatch(/\.trade-journal-page \.tone-loss[\s\S]*?color: var\(--down\)/);
    expect(styles).toMatch(/\.journal-calendar-legend \.is-gain::before \{ background: var\(--up\)/);
    expect(styles).toMatch(/\.journal-calendar-legend \.is-loss::before \{ background: var\(--down\)/);
    expect(styles).toMatch(/\.journal-calendar-day\.is-gain::after \{ background: var\(--up\)/);
    expect(styles).toMatch(/\.journal-calendar-day\.is-loss::after \{ background: var\(--down\)/);
  });

  it("月视图默认不展示复盘区块，发起本月复盘后才生成", async () => {
    const user = userEvent.setup();
    const createReviewReport = vi.fn(async () => {
      throw new Error("未连接复盘服务");
    });
    const api = apiForJournal({
      getAccount: vi.fn(async () => account),
      createReviewReport,
    });
    render(<TradeJournalPage api={api} today="2026-08-17" />);

    expect(await screen.findByRole("heading", { name: "2026年8月" })).toBeInTheDocument();
    expect(await screen.findByRole("grid", { name: "交易月历" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "周期复盘" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "报告版本" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "结构位置归因" })).not.toBeInTheDocument();
    expect(createReviewReport).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "生成本月复盘" }));
    await waitFor(() => expect(createReviewReport).toHaveBeenCalledWith("month", "2026-08-01", "2026-08-31"));
    expect(await screen.findByRole("heading", { name: "周期复盘" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "报告版本" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "结构位置归因" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "列表视图" }));
    expect(await screen.findByRole("heading", { name: "每日交易日志" })).toBeInTheDocument();
    expect(screen.getByLabelText("方向")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "周期复盘" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成本月复盘" })).not.toBeInTheDocument();
  });

  it("周视图默认不展示复盘区块，发起本周复盘后才按交易周生成", async () => {
    const user = userEvent.setup();
    const createReviewReport = vi.fn(async () => {
      throw new Error("未连接复盘服务");
    });
    const api = apiForJournal({
      getAccount: vi.fn(async () => account),
      createReviewReport,
    });
    render(<TradeJournalPage api={api} today="2026-08-17" initialView="week" />);

    expect(await screen.findByRole("button", { name: "周视图" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByRole("grid", { name: "交易周历" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "周期复盘" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "结构位置归因" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "生成本周复盘" }));
    await waitFor(() => expect(createReviewReport).toHaveBeenCalledWith("week", "2026-08-17", "2026-08-21"));
  });

  it("季报和年报默认不展示复盘区块，发起后才按周期生成", async () => {
    const user = userEvent.setup();
    const createReviewReport = vi.fn(async () => {
      throw new Error("未连接复盘服务");
    });
    const api = apiForJournal({
      getAccount: vi.fn(async () => account),
      createReviewReport,
    });
    render(<TradeJournalPage api={api} today="2026-08-17" />);

    expect(await screen.findByRole("heading", { name: "2026年8月" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "季报" }));
    expect(await screen.findByRole("heading", { name: "2026年第三季度" })).toBeInTheDocument();
    expect(screen.queryByRole("grid", { name: "交易月历" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "周期复盘" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "报告版本" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "生成本季复盘" }));
    await waitFor(() => expect(createReviewReport).toHaveBeenCalledWith("quarter", "2026-07-01", "2026-09-30"));

    await user.click(screen.getByRole("button", { name: "年报" }));
    expect(await screen.findByRole("heading", { name: "2026年" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "周期复盘" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "生成本年复盘" }));
    await waitFor(() => expect(createReviewReport).toHaveBeenCalledWith("year", "2026-01-01", "2026-12-31"));
  });

  it("默认月视图请求当月摘要并渲染收益图", async () => {
    const getPeriodSummary = vi.fn(async (start: string, end: string) => ({ start, end, maxDrawdown: null, returnCurve: [] }));
    const api = apiForJournal({
      getAccount: vi.fn(async () => account),
      getPeriodSummary,
    });

    render(<TradeJournalPage api={api} today="2026-08-17" />);

    await waitFor(() => expect(getPeriodSummary).toHaveBeenCalledWith("2026-08-01", "2026-08-31"));
    expect(await screen.findByRole("img", { name: "收益图 month 2026-08-01 2026-08-31" })).toBeInTheDocument();
  });

  it("周季年视图沿用正确边界并渲染对应收益图", async () => {
    const user = userEvent.setup();
    const getPeriodSummary = vi.fn(async (start: string, end: string) => ({ start, end, maxDrawdown: null, returnCurve: [] }));
    const api = apiForJournal({
      getAccount: vi.fn(async () => account),
      getPeriodSummary,
    });
    render(<TradeJournalPage api={api} today="2026-08-17" initialView="week" />);

    expect(await screen.findByRole("img", { name: "收益图 week 2026-08-17 2026-08-21" })).toBeInTheDocument();
    expect(getPeriodSummary).toHaveBeenCalledWith("2026-08-17", "2026-08-21");

    await user.click(screen.getByRole("button", { name: "季报" }));
    expect(await screen.findByRole("img", { name: "收益图 quarter 2026-07-01 2026-09-30" })).toBeInTheDocument();
    expect(getPeriodSummary).toHaveBeenCalledWith("2026-07-01", "2026-09-30");

    await user.click(screen.getByRole("button", { name: "年报" }));
    expect(await screen.findByRole("img", { name: "收益图 year 2026-01-01 2026-12-31" })).toBeInTheDocument();
    expect(getPeriodSummary).toHaveBeenCalledWith("2026-01-01", "2026-12-31");
  });

  it("切换周期后收益图先进入加载态，再展示新周期摘要", async () => {
    const user = userEvent.setup();
    let resolveSeptember: ((summary: TradingPeriodSummary) => void) | undefined;
    const getPeriodSummary = vi.fn((start: string, end: string) => {
      if (start === "2026-08-01") return Promise.resolve({ start, end, maxDrawdown: null, returnCurve: [] });
      return new Promise<TradingPeriodSummary>((resolve) => { resolveSeptember = resolve; });
    });
    const api = apiForJournal({
      getAccount: vi.fn(async () => account),
      getPeriodSummary,
    });
    render(<TradeJournalPage api={api} today="2026-08-17" />);

    expect(await screen.findByRole("img", { name: "收益图 month 2026-08-01 2026-08-31" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "下个月" }));
    await waitFor(() => expect(getPeriodSummary).toHaveBeenCalledWith("2026-09-01", "2026-09-30"));
    expect(await screen.findByRole("img", { name: "收益图 month loading" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "收益图 month 2026-08-01 2026-08-31" })).not.toBeInTheDocument();

    await act(async () => {
      resolveSeptember?.({ start: "2026-09-01", end: "2026-09-30", maxDrawdown: null, returnCurve: [] });
    });
    expect(await screen.findByRole("img", { name: "收益图 month 2026-09-01 2026-09-30" })).toBeInTheDocument();
  });

  it("周期摘要请求失败后展示内联提示而不是永久加载", async () => {
    const api = apiForJournal({
      getAccount: vi.fn(async () => account),
      getPeriodSummary: vi.fn(async () => { throw new Error("周期摘要失败"); }),
    });

    render(<TradeJournalPage api={api} today="2026-08-17" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("周期摘要失败");
    expect(screen.getByText("收益曲线暂不可用。")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "收益图 month loading" })).not.toBeInTheDocument();
  });

  it("周期摘要首次失败后重试成功则显示收益曲线", async () => {
    let calls = 0;
    const getPeriodSummary = vi.fn(async (start: string, end: string) => {
      calls += 1;
      if (calls === 1) throw new Error("周期摘要失败");
      return {
        start,
        end,
        maxDrawdown: "0.0375",
        returnCurve: [{ date: "2026-08-03", cumulativeReturnRate: { value: "0", unavailableReason: null } }],
      };
    });
    const api = apiForJournal({
      getAccount: vi.fn(async () => account),
      getPeriodSummary,
    });

    render(<TradeJournalPage api={api} today="2026-08-17" />);

    expect(await screen.findByRole("img", { name: "收益图 month 2026-08-01 2026-08-31" })).toBeInTheDocument();
    expect(screen.queryByText("收益曲线暂不可用。")).not.toBeInTheDocument();
    expect(getPeriodSummary).toHaveBeenCalledTimes(2);
  });

  it("列表账本变更后返回同周期不会短暂传入旧摘要", async () => {
    const user = userEvent.setup();
    let periodSummaryCalls = 0;
    const getPeriodSummary = vi.fn((start: string, end: string) => {
      periodSummaryCalls += 1;
      if (periodSummaryCalls === 1) return Promise.resolve({ start, end, maxDrawdown: null, returnCurve: [] });
      return new Promise<TradingPeriodSummary>(() => undefined);
    });
    const createCashFlow = vi.fn(async () => ({
      cashFlowId: "cash-flow-1",
      occurredAt: "2026-08-17T15:00:00+08:00",
      kind: "deposit" as const,
      amount: "1000.00",
      note: "测试入金",
      clientIdempotencyKey: "11111111-1111-4111-8111-111111111111",
      revision: 1,
      ledgerRevision: 1,
    }));
    const api = apiForJournal({
      getAccount: vi.fn(async () => account),
      getPeriodSummary,
      createCashFlow,
    });
    render(<TradeJournalPage api={api} today="2026-08-17" />);

    expect(await screen.findByRole("img", { name: "收益图 month 2026-08-01 2026-08-31" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "列表视图" }));
    await user.type(screen.getByLabelText("金额 (CNY)"), "1000.00");
    await user.type(screen.getByLabelText("流水备注"), "测试入金");
    await user.click(screen.getByRole("button", { name: "记录资金流水" }));
    await waitFor(() => expect(createCashFlow).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "记录资金流水" })).not.toBeDisabled());

    journalReturnChartRender.mockClear();
    await user.click(screen.getByRole("button", { name: "月视图" }));
    await waitFor(() => expect(getPeriodSummary).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("img", { name: "收益图 month loading" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "收益图 month 2026-08-01 2026-08-31" })).not.toBeInTheDocument();
    expect(journalReturnChartRender.mock.calls.every(([props]) => props.summary === undefined)).toBe(true);
  });

  it("列表未修改账本时返回同周期也不会短暂传入旧摘要", async () => {
    const user = userEvent.setup();
    let periodSummaryCalls = 0;
    const getPeriodSummary = vi.fn((start: string, end: string) => {
      periodSummaryCalls += 1;
      if (periodSummaryCalls === 1) return Promise.resolve({ start, end, maxDrawdown: null, returnCurve: [] });
      return new Promise<TradingPeriodSummary>(() => undefined);
    });
    const api = apiForJournal({
      getAccount: vi.fn(async () => account),
      getPeriodSummary,
    });
    render(<TradeJournalPage api={api} today="2026-08-17" />);

    expect(await screen.findByRole("img", { name: "收益图 month 2026-08-01 2026-08-31" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "列表视图" }));

    journalReturnChartRender.mockClear();
    await user.click(screen.getByRole("button", { name: "月视图" }));
    await waitFor(() => expect(getPeriodSummary).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("img", { name: "收益图 month loading" })).toBeInTheDocument();
    expect(journalReturnChartRender.mock.calls.every(([props]) => props.summary === undefined)).toBe(true);
  });

  it("重复点击当前周期视图不会清空摘要或重复请求", async () => {
    const user = userEvent.setup();
    const getPeriodSummary = vi.fn(async (start: string, end: string) => ({ start, end, maxDrawdown: null, returnCurve: [] }));
    const api = apiForJournal({
      getAccount: vi.fn(async () => account),
      getPeriodSummary,
    });
    render(<TradeJournalPage api={api} today="2026-08-17" />);

    expect(await screen.findByRole("img", { name: "收益图 month 2026-08-01 2026-08-31" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "月视图" }));

    expect(screen.getByRole("img", { name: "收益图 month 2026-08-01 2026-08-31" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "收益图 month loading" })).not.toBeInTheDocument();
    expect(getPeriodSummary).toHaveBeenCalledTimes(1);
  });

  it("周视图在同一周切换日期不重复请求周期摘要", async () => {
    const user = userEvent.setup();
    const getPeriodSummary = vi.fn(async (start: string, end: string) => ({ start, end, maxDrawdown: null, returnCurve: [] }));
    const api = apiForJournal({
      getAccount: vi.fn(async () => account),
      getPeriodSummary,
    });
    render(<TradeJournalPage api={api} today="2026-08-17" initialView="week" />);

    expect(await screen.findByRole("img", { name: "收益图 week 2026-08-17 2026-08-21" })).toBeInTheDocument();
    expect(getPeriodSummary).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: /2026年8月18日/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /2026年8月18日/ })).toHaveAttribute("aria-pressed", "true"));
    expect(getPeriodSummary).toHaveBeenCalledTimes(1);
  });

  it("列表初始视图不请求周期摘要也不渲染收益图", async () => {
    const getPeriodSummary = vi.fn(async (start: string, end: string) => ({ start, end, maxDrawdown: null, returnCurve: [] }));
    const api = apiForJournal({
      getAccount: vi.fn(async () => account),
      getPeriodSummary,
    });

    render(<TradeJournalPage api={api} today="2026-08-17" initialView="list" />);

    expect(await screen.findByRole("heading", { name: "每日交易日志" })).toBeInTheDocument();
    expect(getPeriodSummary).not.toHaveBeenCalled();
    expect(screen.queryByRole("img", { name: /^收益图/ })).not.toBeInTheDocument();
  });

  it("月周日历之后是收益图，收益图之后是周期复盘入口", async () => {
    const user = userEvent.setup();
    const api = apiForJournal({ getAccount: vi.fn(async () => account) });
    render(<TradeJournalPage api={api} today="2026-08-17" />);

    const monthCalendar = await screen.findByRole("grid", { name: "交易月历" });
    const monthChart = await screen.findByRole("img", { name: "收益图 month 2026-08-01 2026-08-31" });
    const monthReview = screen.getByRole("button", { name: "生成本月复盘" });
    expect(monthCalendar.compareDocumentPosition(monthChart) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(monthChart.compareDocumentPosition(monthReview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "周视图" }));
    const weekCalendar = await screen.findByRole("grid", { name: "交易周历" });
    const weekChart = await screen.findByRole("img", { name: "收益图 week 2026-08-17 2026-08-21" });
    const weekReview = screen.getByRole("button", { name: "生成本周复盘" });
    expect(weekCalendar.compareDocumentPosition(weekChart) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(weekChart.compareDocumentPosition(weekReview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("季年指标之后是收益图，收益图之后是周期复盘入口", async () => {
    const user = userEvent.setup();
    const api = apiForJournal({ getAccount: vi.fn(async () => account) });
    render(<TradeJournalPage api={api} today="2026-08-17" initialView="quarter" />);

    const metrics = await screen.findByRole("group", { name: "账户概览" });
    const quarterChart = await screen.findByRole("img", { name: "收益图 quarter 2026-07-01 2026-09-30" });
    const quarterReview = screen.getByRole("button", { name: "生成本季复盘" });
    expect(metrics.compareDocumentPosition(quarterChart) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(quarterChart.compareDocumentPosition(quarterReview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "年报" }));
    const yearChart = await screen.findByRole("img", { name: "收益图 year 2026-01-01 2026-12-31" });
    const yearReview = screen.getByRole("button", { name: "生成本年复盘" });
    expect(metrics.compareDocumentPosition(yearChart) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(yearChart.compareDocumentPosition(yearReview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
