import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TradeJournalPage } from "./TradeJournalPage";
import type { DailyReview, ReviewPeriodKind, TradingAccount, TradingCalendarMonth, TradingExecution, TradingPeriodSummary } from "./trading-types";
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
    getBsSummary: vi.fn(async (start: string, end: string) => ({ start, end, symbols: [] })),
    getBsChart: vi.fn(), listChartMarks: vi.fn(), createChartMark: vi.fn(), updateChartMark: vi.fn(), deleteChartMark: vi.fn(), listChartMarkTypes: vi.fn(), createChartMarkType: vi.fn(), updateChartMarkType: vi.fn(), deleteChartMarkType: vi.fn(),
    ...overrides,
  };
}

describe("交易日记", () => {
  it("将日历、记账和周期报告分为主导航与对应次级视图", async () => {
    const user = userEvent.setup();
    render(<TradeJournalPage api={apiForJournal({ getAccount: vi.fn(async () => account) })} today="2026-08-17" />);
    const navigation = within(await screen.findByRole("navigation", { name: "交易日记导航" }));
    expect(navigation.getByRole("button", { name: "交易日历" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("group", { name: "日历显示方式" })).toHaveTextContent("月视图周视图");
    expect(screen.queryByRole("button", { name: "季报" })).not.toBeInTheDocument();
    await user.click(navigation.getByRole("button", { name: "周期报告" }));
    expect(screen.getByRole("group", { name: "报告周期" })).toHaveTextContent("季报年报");
    expect(screen.queryByRole("button", { name: "月视图" })).not.toBeInTheDocument();
    await user.click(navigation.getByRole("button", { name: "记账与日复盘" }));
    expect(screen.getByRole("heading", { name: "每日交易日志" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "报告周期" })).not.toBeInTheDocument();
    await user.click(navigation.getByRole("button", { name: "交易日历" }));
    expect(screen.getByRole("button", { name: "月视图" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "生成本月复盘" })).toBeInTheDocument();
  });

  it("日历可直接跳转月份并回到今天", async () => {
    const user = userEvent.setup();
    const getCalendar = vi.fn(async (month: string) => emptyCalendar(month));
    render(<TradeJournalPage api={apiForJournal({ getAccount: vi.fn(async () => account), getCalendar })} today="2026-08-17" />);
    await screen.findByRole("grid", { name: "交易月历" });
    await user.click(screen.getByRole("button", { name: "选择月份" }));
    await user.click(within(screen.getByRole("dialog", { name: "选择月份" })).getByRole("button", { name: "7月" }));
    expect(screen.getByRole("heading", { name: "2026年7月" })).toBeInTheDocument();
    expect(getCalendar).toHaveBeenCalledWith("2026-07");
    await user.click(screen.getByRole("button", { name: "今天" }));
    expect(await screen.findByRole("heading", { name: "2026年8月" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择月份" })).toHaveTextContent("2026年8月");
  });

  it("快捷入口聚焦对应编辑区并保留未保存复盘", async () => {
    const user = userEvent.setup();
    render(<TradeJournalPage api={apiForJournal({ getAccount: vi.fn(async () => account) })} today="2026-08-17" />);
    await user.click(await screen.findByRole("button", { name: "写复盘" }));
    expect(screen.getByRole("region", { name: "收盘检查" })).toHaveFocus();
    await user.type(screen.getByLabelText("常规日志备注"), "导航后仍需保留的复盘");
    await user.click(screen.getByRole("button", { name: "交易日历" }));
    await user.click(screen.getByRole("button", { name: "记一笔" }));
    expect(screen.getByRole("form", { name: "成交录入" })).toHaveFocus();
    expect(screen.getByLabelText("常规日志备注")).toHaveValue("导航后仍需保留的复盘");
    await user.click(screen.getByRole("button", { name: "写复盘" }));
    expect(screen.getByRole("region", { name: "收盘检查" })).toHaveFocus();
  });

  it("当日明细约束键盘焦点，关闭返回日期，快捷复盘定位同一天", async () => {
    const user = userEvent.setup();
    render(<TradeJournalPage api={apiForJournal({ getAccount: vi.fn(async () => account) })} today="2026-08-17" />);
    const day = await screen.findByRole("button", { name: /2026年8月18日，/ });
    await user.click(day);
    const dialog = within(screen.getByRole("dialog", { name: "当日明细" }));
    const close = dialog.getByRole("button", { name: "关闭当日明细" });
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(dialog.getByRole("button", { name: "写复盘" })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(day).toHaveFocus();
    await user.click(day);
    await user.click(within(screen.getByRole("dialog", { name: "当日明细" })).getByRole("button", { name: "写复盘" }));
    expect(screen.getByRole("region", { name: "收盘检查" })).toHaveFocus();
    expect(screen.getByLabelText("交易日期")).toHaveValue("2026-08-18");
  });

  it.each([true, false])("跨月日期关闭明细后恢复到可用日历入口（新月份已加载：%s）", async (loaded) => {
    const user = userEvent.setup();
    let resolveSeptember: (calendar: TradingCalendarMonth) => void = () => {};
    const september = new Promise<TradingCalendarMonth>((resolve) => { resolveSeptember = resolve; });
    const getCalendar = vi.fn(async (month: string) => month === "2026-09" ? september : emptyCalendar(month));
    render(<TradeJournalPage api={apiForJournal({ getAccount: vi.fn(async () => account), getCalendar })} today="2026-08-17" />);
    const originalDay = await screen.findByRole("button", { name: /2026年9月1日，/ });
    await user.click(originalDay);
    expect(originalDay).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭当日明细" })).toHaveFocus();
    if (loaded) await act(async () => { resolveSeptember(emptyCalendar("2026-09")); });

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "当日明细" })).not.toBeInTheDocument();
    const expectedTarget = loaded
      ? screen.getByRole("button", { name: /2026年9月1日，/ })
      : within(screen.getByRole("navigation", { name: "交易日记导航" })).getByRole("button", { name: "交易日历" });
    expect(expectedTarget).toHaveFocus();
  });

  it("账户加载失败不会显示创建账户，重试后恢复日记", async () => {
    const user = userEvent.setup();
    const getAccount = vi.fn().mockRejectedValueOnce(new Error("账户连接失败")).mockResolvedValue(account);
    render(<TradeJournalPage api={apiForJournal({ getAccount })} today="2026-08-17" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("账户连接失败");
    expect(screen.queryByRole("heading", { name: "创建交易账户" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新加载账户" }));
    expect(await screen.findByRole("heading", { name: "2026年8月" })).toBeInTheDocument();
  });

  it("当日加载失败提供重试，不将失败显示为读取中或没有复盘", async () => {
    const user = userEvent.setup();
    const listExecutions = vi.fn().mockRejectedValueOnce(new Error("成交连接失败")).mockResolvedValue([]);
    render(<TradeJournalPage api={apiForJournal({ getAccount: vi.fn(async () => account), listExecutions })} today="2026-08-17" initialView="list" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("成交连接失败");
    expect(screen.queryByText("正在读取成交…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存草稿" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "重新加载当日数据" }));
    expect(await screen.findByText("今日没有交易记录。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存草稿" })).toBeEnabled();
  });

  it("当日明细弹窗内可重试失败的数据加载", async () => {
    const user = userEvent.setup();
    const listExecutions = vi.fn().mockRejectedValueOnce(new Error("成交连接失败")).mockResolvedValue([]);
    render(<TradeJournalPage api={apiForJournal({ getAccount: vi.fn(async () => account), listExecutions })} today="2026-08-17" />);
    await user.click(await screen.findByRole("button", { name: /2026年8月17日，/ }));
    const dialog = within(screen.getByRole("dialog", { name: "当日明细" }));
    expect(dialog.getByRole("alert")).toHaveTextContent("成交连接失败");
    expect(dialog.queryByText("当日尚未写复盘。")).not.toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "重新加载当日数据" }));
    expect(await dialog.findByText("当日没有成交。")).toBeInTheDocument();
  });

  it("首次日期复盘加载完成前禁止编辑，加载后保留完整服务端内容", async () => {
    let finishLoad!: (value: DailyReview) => void;
    const saved: DailyReview = { dailyReviewId: "review-17", tradeDate: "2026-08-17", status: "draft", invalidationCondition: "跌破前低", nextDayPlan: "观察已有持仓", emotion: "confident", disciplineFollowed: true, note: "原有复盘", revision: 3, dailyReviewRevision: 3 };
    render(<TradeJournalPage api={apiForJournal({ getAccount: vi.fn(async () => account), getDailyReview: () => new Promise((resolve) => { finishLoad = resolve; }) })} today="2026-08-17" initialView="list" />);
    expect(await screen.findByLabelText("常规日志备注")).toBeDisabled();
    expect(screen.getByLabelText("明日计划")).toBeDisabled();
    expect(screen.getByLabelText("情绪状态(交易中)")).toBeDisabled();
    await act(async () => finishLoad(saved));
    expect(screen.getByLabelText("常规日志备注")).toBeEnabled();
    expect(screen.getByLabelText("常规日志备注")).toHaveValue("原有复盘");
    expect(screen.getByLabelText("明日计划")).toHaveValue("观察已有持仓");
    expect(screen.getByLabelText("失败条件/市场失效")).toHaveValue("跌破前低");
    expect(screen.getByLabelText("是否遵守计划")).toHaveValue("true");
  });

  it("按日期保留未保存复盘，保存成交后的账户刷新不覆盖草稿", async () => {
    const user = userEvent.setup();
    const saved: TradingExecution = {
      executionId: "draft-trade", symbol: "002940.SZ", name: "昂利康", executedAt: "2026-08-17T15:00:00+08:00", side: "buy", price: "20", quantity: 100, fee: "0", primaryReason: "pullback_confirmation", tags: [], note: "", clientIdempotencyKey: "draft-trade", revision: 1, ledgerRevision: 1,
    };
    const getDailyReview = vi.fn(async () => null);
    render(<TradeJournalPage api={apiForJournal({ getAccount: vi.fn(async () => ({ ...account })), getDailyReview, createExecution: vi.fn(async () => saved) })} today="2026-08-17" initialView="list" />);
    await screen.findByText("今日没有交易记录。");
    await user.type(screen.getByLabelText("常规日志备注"), "保留十七日草稿");
    await act(async () => { fireEvent.change(screen.getByLabelText("交易日期"), { target: { value: "2026-08-18" } }); });
    await waitFor(() => expect(getDailyReview).toHaveBeenCalledWith("2026-08-18"));
    await user.type(screen.getByLabelText("常规日志备注"), "保留十八日草稿");
    await act(async () => { fireEvent.change(screen.getByLabelText("交易日期"), { target: { value: "2026-08-17" } }); });
    await waitFor(() => expect(screen.getByLabelText("常规日志备注")).toHaveValue("保留十七日草稿"));
    await user.type(screen.getByLabelText("代码"), "002940.SZ");
    await user.clear(screen.getByLabelText("成交价"));
    await user.type(screen.getByLabelText("成交价"), "20");
    await user.click(screen.getByRole("button", { name: "保存交易记录" }));
    await waitFor(() => expect(getDailyReview.mock.calls.length).toBeGreaterThan(3));
    expect(screen.getByLabelText("常规日志备注")).toHaveValue("保留十七日草稿");
    expect(screen.getByRole("status", { name: "复盘保存状态" })).toHaveTextContent("有未保存修改");
    await act(async () => { fireEvent.change(screen.getByLabelText("交易日期"), { target: { value: "2026-08-18" } }); });
    expect(screen.getByLabelText("常规日志备注")).toHaveValue("保留十八日草稿");
  });

  it("旧日期保存完成不会覆盖新日期草稿，保存中再次编辑仍保持未保存", async () => {
    const user = userEvent.setup();
    let finishSave!: (value: DailyReview) => void;
    const saveDailyReview = vi.fn(() => new Promise<DailyReview>((resolve) => { finishSave = resolve; }));
    const api = apiForJournal({ getAccount: vi.fn(async () => account), saveDailyReview });
    render(<TradeJournalPage api={api} today="2026-08-17" initialView="list" />);
    await screen.findByText("今日没有交易记录。");
    await user.type(screen.getByLabelText("常规日志备注"), "提交版本");
    await user.click(screen.getByRole("button", { name: "保存草稿" }));
    expect(screen.getByRole("button", { name: "正在保存…" })).toBeDisabled();
    await user.type(screen.getByLabelText("常规日志备注"), "继续编辑");
    await act(async () => { fireEvent.change(screen.getByLabelText("交易日期"), { target: { value: "2026-08-18" } }); });
    await waitFor(() => expect(api.getDailyReview).toHaveBeenCalledWith("2026-08-18"));
    await user.type(screen.getByLabelText("常规日志备注"), "十八日内容");
    await act(async () => finishSave({ dailyReviewId: "review-17", tradeDate: "2026-08-17", status: "draft", invalidationCondition: "", nextDayPlan: "", emotion: "calm", disciplineFollowed: null, note: "提交版本", revision: 1, dailyReviewRevision: 1 }));
    expect(saveDailyReview).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("常规日志备注")).toHaveValue("十八日内容");
    await act(async () => { fireEvent.change(screen.getByLabelText("交易日期"), { target: { value: "2026-08-17" } }); });
    expect(screen.getByLabelText("常规日志备注")).toHaveValue("提交版本继续编辑");
    expect(screen.getByRole("status", { name: "复盘保存状态" })).toHaveTextContent("有未保存修改");
  });

  it("保存失败保留草稿，重试成功后显示已保存", async () => {
    const user = userEvent.setup();
    const saved: DailyReview = { dailyReviewId: "review-17", tradeDate: "2026-08-17", status: "draft", invalidationCondition: "", nextDayPlan: "", emotion: "calm", disciplineFollowed: null, note: "保留这段复盘", revision: 1, dailyReviewRevision: 1 };
    const saveDailyReview = vi.fn().mockRejectedValueOnce(new Error("保存连接失败")).mockResolvedValue(saved);
    render(<TradeJournalPage api={apiForJournal({ getAccount: vi.fn(async () => account), saveDailyReview })} today="2026-08-17" initialView="list" />);
    await screen.findByText("今日没有交易记录。");
    await user.type(screen.getByLabelText("常规日志备注"), "保留这段复盘");
    await user.click(screen.getByRole("button", { name: "保存草稿" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("保存连接失败");
    expect(screen.getByLabelText("常规日志备注")).toHaveValue("保留这段复盘");
    expect(screen.getByRole("status", { name: "复盘保存状态" })).toHaveTextContent("有未保存修改");
    await user.click(screen.getByRole("button", { name: "保存草稿" }));
    expect(await screen.findByRole("status", { name: "复盘保存状态" })).toHaveTextContent("已保存");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

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
    await user.click(screen.getByRole("button", { name: "记账与日复盘" }));
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

  it("输入名称或代码后从候选自动填写代码与名称", async () => {
    const user = userEvent.setup();
    const searchStocks = vi.fn(async () => [
      { symbol: "002309.SZ", name: "中利集团", cnspell: "zljt" },
    ]);
    const createExecution = vi.fn(async () => ({
      executionId: "execution-1",
      symbol: "002309.SZ",
      name: "中利集团",
      executedAt: "2026-08-17T14:30:00+08:00",
      side: "buy" as const,
      price: "3.21",
      quantity: 100,
      fee: "5.00",
      primaryReason: "pullback_confirmation" as const,
      tags: [],
      note: "",
      clientIdempotencyKey: "11111111-1111-4111-8111-111111111111",
      revision: 1,
      ledgerRevision: 1,
    }));
    const api = apiForJournal({ getAccount: vi.fn(async () => account), createExecution });
    render(<TradeJournalPage api={api} today="2026-08-17" searchStocks={searchStocks} />);

    expect(await screen.findByRole("heading", { name: "2026年8月" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "记账与日复盘" }));
    expect(await screen.findByRole("heading", { name: "每日交易日志" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("代码"), "中利");
    const option = await screen.findByRole("option", { name: /中利集团/ });
    await user.click(option);

    expect(screen.getByLabelText("代码")).toHaveValue("002309.SZ");
    expect(screen.getByLabelText("资产名称")).toHaveValue("中利集团");

    await user.clear(screen.getByLabelText("成交价"));
    await user.type(screen.getByLabelText("成交价"), "3.21");
    await user.clear(screen.getByLabelText("份额/数量"));
    await user.type(screen.getByLabelText("份额/数量"), "100");
    await user.click(screen.getByRole("button", { name: "保存交易记录" }));

    await waitFor(() => expect(createExecution).toHaveBeenCalledWith(expect.objectContaining({
      symbol: "002309.SZ",
      name: "中利集团",
    })));
  });

  it("无资金流水时默认收起，点击后可录入", async () => {
    const user = userEvent.setup();
    render(<TradeJournalPage api={apiForJournal({ getAccount: vi.fn(async () => account) })} today="2026-08-17" initialView="list" />);

    expect(await screen.findByRole("heading", { name: "每日交易日志" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "记录资金流水" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "＋ 记一笔资金流水" }));
    expect(screen.getByRole("button", { name: "记录资金流水" })).toBeInTheDocument();
    expect(screen.getByLabelText("金额 (CNY)")).toBeInTheDocument();
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
    expect(screen.queryByRole("dialog", { name: "当日明细" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /2026年8月17日，1 笔成交/ })).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByRole("button", { name: "上个月" }));
    expect(getCalendar).toHaveBeenCalledWith("2026-07");
    expect(await screen.findByRole("heading", { name: "2026年7月" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "下个月" }));
    expect(await screen.findByRole("heading", { name: "2026年8月" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /2026年8月17日，1 笔成交/ }));
    expect(await screen.findByRole("dialog", { name: "当日明细" })).toBeInTheDocument();
    expect(await screen.findByText("002940.SZ")).toBeInTheDocument();
    expect(screen.getByText("草稿")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /2026年8月17日，1 笔成交/ })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "关闭当日明细" }));
    expect(screen.queryByRole("dialog", { name: "当日明细" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /2026年8月17日，1 笔成交/ }));
    await user.click(within(screen.getByRole("dialog", { name: "当日明细" })).getByRole("button", { name: "记一笔" }));
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

    await user.click(screen.getByRole("button", { name: "周期报告" }));
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
    expect(styles).toMatch(/\.journal-calendar-layout \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\);/);
  });

  it("月视图在日历下方展示该月个股交易详情，不需要先生成复盘", async () => {
    const getBsSummary = vi.fn(async (start: string, end: string) => ({
      start,
      end,
      symbols: [{
        symbol: "002041.SZ",
        name: "登海种业",
        realizedPnl: "4377.88",
        periodPnl: "4377.88",
        closedCycleCount: 2,
        medianHoldingDays: { value: "13", unavailableReason: null },
        winRate: { value: "1", unavailableReason: null },
      }],
    }));
    const api = apiForJournal({
      getAccount: vi.fn(async () => account),
      getBsSummary,
    });
    render(<TradeJournalPage api={api} today="2026-08-17" />);

    expect(await screen.findByRole("heading", { name: "2026年8月" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "个股 BS 分析" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /登海种业/ })).toBeInTheDocument();
    expect(getBsSummary).toHaveBeenCalledWith("2026-08-01", "2026-08-31");
    expect(screen.queryByRole("heading", { name: "周期复盘" })).not.toBeInTheDocument();
  });

  it("周视图按当周区间请求个股交易详情", async () => {
    const getBsSummary = vi.fn(async (start: string, end: string) => ({ start, end, symbols: [] }));
    const api = apiForJournal({
      getAccount: vi.fn(async () => account),
      getBsSummary,
    });
    render(<TradeJournalPage api={api} today="2026-08-17" initialView="week" />);

    expect(await screen.findByRole("heading", { name: "个股 BS 分析" })).toBeInTheDocument();
    await waitFor(() => expect(getBsSummary).toHaveBeenCalledWith("2026-08-17", "2026-08-21"));
    expect(screen.getByText("本周期没有持仓或成交股票。")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "周期复盘" })).not.toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: "记账与日复盘" }));
    expect(await screen.findByRole("heading", { name: "每日交易日志" })).toBeInTheDocument();
    expect(screen.getByLabelText("方向")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "周期复盘" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "个股 BS 分析" })).not.toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "周期报告" }));
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

    await user.click(screen.getByRole("button", { name: "周期报告" }));
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
    await user.click(screen.getByRole("button", { name: "记账与日复盘" }));
    await user.click(screen.getByRole("button", { name: "＋ 记一笔资金流水" }));
    await user.type(screen.getByLabelText("金额 (CNY)"), "1000.00");
    await user.type(screen.getByLabelText("流水备注"), "测试入金");
    await user.click(screen.getByRole("button", { name: "记录资金流水" }));
    await waitFor(() => expect(createCashFlow).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "记录资金流水" })).not.toBeDisabled());

    journalReturnChartRender.mockClear();
    await user.click(screen.getByRole("button", { name: "交易日历" }));
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
    await user.click(screen.getByRole("button", { name: "记账与日复盘" }));

    journalReturnChartRender.mockClear();
    await user.click(screen.getByRole("button", { name: "交易日历" }));
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
    const monthBs = await screen.findByRole("heading", { name: "个股 BS 分析" });
    const monthReview = screen.getByRole("button", { name: "生成本月复盘" });
    expect(monthCalendar.compareDocumentPosition(monthChart) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(monthChart.compareDocumentPosition(monthBs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(monthBs.compareDocumentPosition(monthReview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "周视图" }));
    const weekCalendar = await screen.findByRole("grid", { name: "交易周历" });
    const weekChart = await screen.findByRole("img", { name: "收益图 week 2026-08-17 2026-08-21" });
    const weekBs = await screen.findByRole("heading", { name: "个股 BS 分析" });
    const weekReview = screen.getByRole("button", { name: "生成本周复盘" });
    expect(weekCalendar.compareDocumentPosition(weekChart) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(weekChart.compareDocumentPosition(weekBs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(weekBs.compareDocumentPosition(weekReview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
