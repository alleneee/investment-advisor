import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BsAnalysisPanel } from "./BsAnalysisPanel";
import type { TradingApi } from "./trading-api";
import type {
  BsChart,
  BsChartExecution,
  BsSymbolSummary,
  ChartMark,
  ChartMarkType,
  TradingChartBar,
} from "./trading-types";

const captured = vi.hoisted(() => ({
  props: null as {
    highlightOccurredAt: string | null;
    marks: ChartMark[];
    types: ChartMarkType[];
    onSelectBar?: (occurredAt: string) => void;
    chart: { available: boolean; bars: unknown[]; timeframe: string; symbol: string };
  } | null,
}));

vi.mock("./BsChart", () => ({
  BsChart: (props: NonNullable<typeof captured.props>) => {
    captured.props = props;
    if (!props.chart.available || props.chart.bars.length === 0) {
      return <div>行情不可用</div>;
    }
    return <div
      data-testid="bs-chart"
      data-highlight={props.highlightOccurredAt ?? ""}
      data-mark-ids={props.marks.map((item) => item.markId).join(",")}
    >
      <button type="button" onClick={() => props.onSelectBar?.("2026-08-10T00:00:00+08:00")}>选择K线</button>
      <button type="button" onClick={() => props.onSelectBar?.("2026-08-14T00:00:00+08:00")}>选择K线 8月14日</button>
    </div>;
  },
}));

const BAR_AT = "2026-08-10T00:00:00+08:00";
const PERIOD_START = "2026-08-10";
const PERIOD_END = "2026-08-16";

function bar(overrides: Partial<TradingChartBar> = {}): TradingChartBar {
  return {
    tradeDate: "2026-07-05",
    occurredAt: "2026-07-05T00:00:00+08:00",
    open: "10",
    high: "11",
    low: "9",
    close: "10.5",
    volume: "1000",
    ...overrides,
  };
}

function execution(overrides: Partial<BsChartExecution> = {}): BsChartExecution {
  return {
    executionId: "execution-1",
    symbol: "002041.SZ",
    occurredAt: "2026-08-10T10:00:00+08:00",
    barOccurredAt: BAR_AT,
    side: "buy",
    price: "10.50",
    quantity: 100,
    fee: "5.00",
    primaryReason: "pullback_confirmation",
    ...overrides,
  };
}

function symbolSummary(overrides: Partial<BsSymbolSummary> = {}): BsSymbolSummary {
  return {
    symbol: "002041.SZ",
    name: "登海种业",
    realizedPnl: "4377.88",
    periodPnl: "4377.88",
    closedCycleCount: 2,
    medianHoldingDays: { value: "13", unavailableReason: null },
    winRate: { value: "1", unavailableReason: null },
    ...overrides,
  };
}

function dailyChart(symbol = "002041.SZ", overrides: Partial<BsChart> = {}): BsChart {
  return {
    symbol,
    timeframe: "1d",
    available: true,
    adjustment: "none",
    bars: [
      bar(),
      bar({ tradeDate: "2026-08-10", occurredAt: BAR_AT, open: "10.5", close: "11", high: "12", low: "10" }),
      bar({ tradeDate: "2026-08-16", occurredAt: "2026-08-16T00:00:00+08:00", open: "11", close: "12", high: "13", low: "10.5" }),
    ],
    executions: [
      execution({ symbol }),
      execution({
        executionId: "execution-2",
        symbol,
        occurredAt: "2026-08-14T14:00:00+08:00",
        barOccurredAt: "2026-08-14T00:00:00+08:00",
        side: "sell",
        price: "12.30",
        quantity: 100,
        primaryReason: "take_profit",
      }),
    ],
    macd: { ready: false, dif: [], dea: [], histogram: [] },
    quality: { status: "ok", warnings: [] },
    ...overrides,
  };
}

function unavailableChart(symbol: string, timeframe: "1d" | "30m"): BsChart {
  return {
    symbol,
    timeframe,
    available: false,
    adjustment: "none",
    bars: [],
    executions: [],
    macd: { ready: false, dif: [], dea: [], histogram: [] },
    quality: { status: "unavailable", warnings: ["stk_mins failed"] },
  };
}

const disabledType: ChartMarkType = {
  typeId: "type-disabled",
  accountId: "account-1",
  code: "old_high",
  label: "停用高点",
  letter: "旧",
  color: "#888888",
  preset: false,
  enabled: false,
  createdAt: "2026-08-01T00:00:00+08:00",
};

const markTypes: ChartMarkType[] = [
  {
    typeId: "type-ideal-buy",
    accountId: "account-1",
    code: "ideal_buy",
    label: "理想买",
    letter: "买",
    color: "#f6465d",
    preset: true,
    enabled: true,
    createdAt: "2026-08-01T00:00:00+08:00",
  },
  {
    typeId: "type-review",
    accountId: "account-1",
    code: "review",
    label: "复盘点",
    letter: "复",
    color: "#9b8cff",
    preset: true,
    enabled: true,
    createdAt: "2026-08-01T00:00:00+08:00",
  },
  disabledType,
];

const existingDisabledMark: ChartMark = {
  markId: "mark-disabled",
  accountId: "account-1",
  symbol: "002041.SZ",
  occurredAt: "2026-08-11T00:00:00+08:00",
  typeId: "type-disabled",
  comment: "旧高点",
  revision: 1,
  createdAt: "2026-08-11T10:00:00+08:00",
  updatedAt: "2026-08-11T10:00:00+08:00",
};

function chartMark(overrides: Partial<ChartMark> = {}): ChartMark {
  return {
    markId: "mark-existing",
    accountId: "account-1",
    symbol: "002041.SZ",
    occurredAt: BAR_AT,
    typeId: "type-ideal-buy",
    comment: "回踩确认",
    revision: 3,
    createdAt: "2026-08-10T10:00:00+08:00",
    updatedAt: "2026-08-10T10:00:00+08:00",
    ...overrides,
  };
}

const symbols: BsSymbolSummary[] = [
  symbolSummary(),
  symbolSummary({
    symbol: "000001.SZ",
    name: "平安银行",
    realizedPnl: "0.00",
    periodPnl: "0.00",
    closedCycleCount: 0,
    medianHoldingDays: { value: null, unavailableReason: "no_closed_cycle" },
    winRate: { value: null, unavailableReason: "no_closed_cycle" },
  }),
];

function apiForPanel(overrides: Partial<TradingApi> = {}): TradingApi {
  let createdMarks = 0;
  return {
    getAccount: vi.fn(), createAccount: vi.fn(), listExecutions: vi.fn(), createExecution: vi.fn(), updateExecution: vi.fn(), deleteExecution: vi.fn(), listCashFlows: vi.fn(), createCashFlow: vi.fn(), deleteCashFlow: vi.fn(), getDailyReview: vi.fn(), saveDailyReview: vi.fn(), getCalendar: vi.fn(), getPeriodSummary: vi.fn(),
    getStructureAttribution: vi.fn(),
    getReviewPreview: vi.fn(),
    createReviewReport: vi.fn(),
    listReviewReports: vi.fn(),
    getReviewReport: vi.fn(),
    retryReviewReport: vi.fn(),
    getBsSummary: vi.fn(async (start: string, end: string) => ({ start, end, symbols })),
    getBsChart: vi.fn(async (symbol: string, timeframe: "1d" | "30m") => (
      timeframe === "30m" ? unavailableChart(symbol, "30m") : dailyChart(symbol)
    )),
    listChartMarks: vi.fn(async () => [existingDisabledMark]),
    createChartMark: vi.fn(async (request) => {
      createdMarks += 1;
      return {
        markId: `mark-created-${createdMarks}`,
        accountId: "account-1",
        symbol: request.symbol,
        occurredAt: request.occurredAt,
        typeId: request.typeId,
        comment: request.comment,
        revision: 1,
        createdAt: request.occurredAt,
        updatedAt: request.occurredAt,
      };
    }),
    updateChartMark: vi.fn(),
    deleteChartMark: vi.fn(),
    listChartMarkTypes: vi.fn(async () => markTypes),
    createChartMarkType: vi.fn(async (request) => ({
      typeId: "type-custom",
      accountId: "account-1",
      code: "custom_1",
      label: request.label,
      letter: request.letter,
      color: request.color,
      preset: false,
      enabled: true,
      createdAt: "2026-08-18T00:00:00+08:00",
    })),
    updateChartMarkType: vi.fn(),
    deleteChartMarkType: vi.fn(),
    ...overrides,
  };
}

function renderPanel(api: TradingApi = apiForPanel()) {
  const user = userEvent.setup();
  render(<BsAnalysisPanel api={api} periodStart={PERIOD_START} periodEnd={PERIOD_END} />);
  return { api, user };
}

describe("BsAnalysisPanel", () => {
  beforeEach(() => {
    captured.props = null;
  });

  it("symbols 为空时展示空态，不渲染假股票也不请求个股图", async () => {
    const api = apiForPanel({
      getBsSummary: vi.fn(async (start: string, end: string) => ({ start, end, symbols: [] })),
    });
    renderPanel(api);

    expect(await screen.findByText("本周期没有持仓或成交股票。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /登海种业|平安银行|示例|演示/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId("bs-chart")).not.toBeInTheDocument();
    expect(screen.queryByText("行情不可用")).not.toBeInTheDocument();
    expect(api.getBsChart).not.toHaveBeenCalled();
  });

  it("有股票但尚未点选时不画个股图", async () => {
    const { api } = renderPanel();

    expect(await screen.findByRole("button", { name: /登海种业/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /平安银行/ })).toBeInTheDocument();
    expect(screen.queryByTestId("bs-chart")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "BS点分析" })).not.toBeInTheDocument();
    expect(screen.queryByText("行情不可用")).not.toBeInTheDocument();
    expect(api.getBsChart).not.toHaveBeenCalled();
  });

  it("没有卖出时瓷砖按窗口收盘盯市收益而不是已实现零", async () => {
    const api = apiForPanel({
      getBsSummary: vi.fn(async (start: string, end: string) => ({
        start,
        end,
        symbols: [symbolSummary({
          symbol: "600156.SH",
          name: "华升股份",
          realizedPnl: "0.00",
          periodPnl: "200.00",
          closedCycleCount: 0,
          medianHoldingDays: { value: null, unavailableReason: "no_closed_cycle" },
          winRate: { value: null, unavailableReason: "no_closed_cycle" },
        })],
      })),
    });
    renderPanel(api);

    const tile = await screen.findByRole("button", { name: /华升股份/ });
    expect(tile).toHaveTextContent("+200.00");
    expect(tile).toHaveClass("tone-up");
  });

  it("零盈亏块可见且为中性色", async () => {
    renderPanel();

    const tile = await screen.findByRole("button", { name: /平安银行/ });
    expect(tile).toHaveTextContent("0.00");
    expect(
      tile.className.includes("tone-neutral")
      || (tile.getAttribute("style") ?? "").includes("#bbcbb2")
      || getComputedStyle(tile).backgroundColor === "rgb(187, 203, 178)",
    ).toBe(true);
  });

  it("点盈亏块后默认 BS点分析与日线，可切 30 分钟，无闭合周期时三个数为 0 / — / —", async () => {
    const { api, user } = renderPanel();

    await user.click(await screen.findByRole("button", { name: /平安银行/ }));

    expect(await screen.findByRole("button", { name: "BS点分析" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "日线" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("建清仓次数")).toBeInTheDocument();
    expect(screen.getByText("平均持仓")).toBeInTheDocument();
    expect(screen.getByText("成功率")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getAllByText("—")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "30分钟" }));
    expect(screen.getByRole("button", { name: "30分钟" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(api.getBsChart).toHaveBeenCalledWith("000001.SZ", "30m", PERIOD_START, PERIOD_END));
  });

  it("交易记录列出当前图的成交，点一行设置 highlightOccurredAt，不打开成交编辑", async () => {
    const { api, user } = renderPanel();

    await user.click(await screen.findByRole("button", { name: /登海种业/ }));
    expect(await screen.findByTestId("bs-chart")).toBeInTheDocument();
    await waitFor(() => expect(api.listChartMarks).toHaveBeenCalledWith("002041.SZ", "2026-07-05", "2026-08-16"));

    await user.click(screen.getByRole("button", { name: "交易记录" }));
    const table = screen.getByRole("table", { name: "交易记录" });
    expect(table).toHaveTextContent("买入");
    expect(table).toHaveTextContent("卖出");
    expect(table).toHaveTextContent("10.50");
    expect(table).toHaveTextContent("12.30");
    expect(screen.queryByLabelText("成交价")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("份额/数量")).not.toBeInTheDocument();
    expect(api.updateExecution).not.toHaveBeenCalled();
    expect(api.listExecutions).not.toHaveBeenCalled();

    await user.click(within(table).getByText("12.30"));
    await waitFor(() => expect(captured.props?.highlightOccurredAt).toBe("2026-08-14T00:00:00+08:00"));
    expect(screen.getByTestId("bs-chart")).toHaveAttribute("data-highlight", "2026-08-14T00:00:00+08:00");
  });

  it("新增成功后进入编辑态，再次保存只更新同一条分析", async () => {
    const created = chartMark({ markId: "mark-created", comment: "回踩", revision: 1 });
    const updated = chartMark({ markId: "mark-created", comment: "二次确认", revision: 2 });
    const api = apiForPanel({
      createChartMark: vi.fn(async () => created),
      updateChartMark: vi.fn(async () => updated),
    });
    const { user } = renderPanel(api);

    await user.click(await screen.findByRole("button", { name: /登海种业/ }));
    await user.click(await screen.findByRole("button", { name: "选择K线" }));

    const picker = await screen.findByRole("form", { name: "图标注记" });
    expect(screen.getByRole("button", { name: "理想买" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "停用高点" })).not.toBeInTheDocument();
    expect(captured.props?.marks.some((item) => item.typeId === "type-disabled")).toBe(true);
    expect(captured.props?.types.some((item) => item.typeId === "type-disabled" && item.enabled === false)).toBe(true);

    await user.click(screen.getByRole("button", { name: "理想买" }));
    await user.type(within(picker).getByLabelText("评论"), "回踩");
    await user.click(within(picker).getByRole("button", { name: "新增分析" }));

    await waitFor(() => expect(api.createChartMark).toHaveBeenCalledWith({
      symbol: "002041.SZ",
      occurredAt: BAR_AT,
      typeId: "type-ideal-buy",
      comment: "回踩",
      timeframe: "1d",
    }));

    expect(within(picker).getByRole("button", { name: "保存修改" })).toBeInTheDocument();
    await user.clear(within(picker).getByLabelText("评论"));
    await user.type(within(picker).getByLabelText("评论"), "二次确认");
    await user.click(within(picker).getByRole("button", { name: "保存修改" }));

    await waitFor(() => expect(api.updateChartMark).toHaveBeenCalledWith("mark-created", {
      comment: "二次确认",
    }, 1));
    expect(api.createChartMark).toHaveBeenCalledTimes(1);
    expect(captured.props?.marks.some((item) => item.markId === "mark-disabled")).toBe(true);
  });

  it("点另一根 K 线后标注切到新柱，保存用新柱时间", async () => {
    const { api, user } = renderPanel();

    await user.click(await screen.findByRole("button", { name: /登海种业/ }));
    await user.click(await screen.findByRole("button", { name: "选择K线" }));
    const picker = await screen.findByRole("form", { name: "图标注记" });
    expect(picker).toHaveTextContent("2026-08-10");

    await user.click(screen.getByRole("button", { name: "选择K线 8月14日" }));
    expect(picker).toHaveTextContent("2026-08-14");
    expect(captured.props?.highlightOccurredAt).toBe("2026-08-14T00:00:00+08:00");

    await user.click(screen.getByRole("button", { name: "理想买" }));
    await user.click(within(picker).getByRole("button", { name: "新增分析" }));
    await waitFor(() => expect(api.createChartMark).toHaveBeenCalledWith({
      symbol: "002041.SZ",
      occurredAt: "2026-08-14T00:00:00+08:00",
      typeId: "type-ideal-buy",
      comment: "",
      timeframe: "1d",
    }));
  });

  it("「+ 新类型」只提交 label、letter、color", async () => {
    const { api, user } = renderPanel();

    await user.click(await screen.findByRole("button", { name: /登海种业/ }));
    await user.click(await screen.findByRole("button", { name: "选择K线" }));
    await user.click(await screen.findByRole("button", { name: "+ 新类型" }));
    await user.type(screen.getByLabelText("名称"), "突破");
    await user.type(screen.getByLabelText("字母"), "突");
    await user.clear(screen.getByLabelText("颜色"));
    await user.type(screen.getByLabelText("颜色"), "#123456");
    await user.click(screen.getByRole("button", { name: "创建类型" }));

    await waitFor(() => expect(api.createChartMarkType).toHaveBeenCalledWith({
      label: "突破",
      letter: "突",
      color: "#123456",
    }));
    expect(api.createChartMarkType).toHaveBeenCalledTimes(1);
    expect(Object.keys(vi.mocked(api.createChartMarkType).mock.calls[0]?.[0] ?? {})).toEqual(["label", "letter", "color"]);
  });

  it("点击 K 线后列出投影到该柱的全部 BS 分析", async () => {
    const api = apiForPanel({
      listChartMarks: vi.fn(async () => [
        chartMark({ markId: "mark-daily", comment: "日线标记" }),
        chartMark({ markId: "mark-minute", occurredAt: "2026-08-10T10:30:00+08:00", typeId: "type-review", comment: "分钟标记" }),
        chartMark({ markId: "mark-other", occurredAt: "2026-08-14T00:00:00+08:00", comment: "其他 K 线" }),
      ]),
    });
    const { user } = renderPanel(api);

    await user.click(await screen.findByRole("button", { name: /登海种业/ }));
    await user.click(await screen.findByRole("button", { name: "选择K线" }));

    const analyses = screen.getByRole("list", { name: "当前 K 线的 BS 分析" });
    expect(analyses).toHaveTextContent("理想买");
    expect(analyses).toHaveTextContent("日线标记");
    expect(analyses).toHaveTextContent("复盘点");
    expect(analyses).toHaveTextContent("分钟标记");
    expect(analyses).not.toHaveTextContent("其他 K 线");
  });

  it("点击当前 K 线已使用的类型会进入编辑态并覆盖原分析", async () => {
    const existing = chartMark();
    const updated = chartMark({ comment: "修改后", revision: 4 });
    const api = apiForPanel({
      listChartMarks: vi.fn(async () => [existing]),
      updateChartMark: vi.fn(async () => updated),
    });
    const { user } = renderPanel(api);

    await user.click(await screen.findByRole("button", { name: /登海种业/ }));
    await user.click(await screen.findByRole("button", { name: "选择K线" }));
    await user.click(screen.getByRole("button", { name: "理想买" }));

    expect(screen.getByLabelText("评论")).toHaveValue("回踩确认");
    expect(screen.getByRole("button", { name: "保存修改" })).toBeInTheDocument();
    await user.clear(screen.getByLabelText("评论"));
    await user.type(screen.getByLabelText("评论"), "修改后");
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    await waitFor(() => expect(api.updateChartMark).toHaveBeenCalledWith("mark-existing", {
      comment: "修改后",
    }, 3));
    expect(api.createChartMark).not.toHaveBeenCalled();
  });

  it("历史同类型分析重复时点击类型默认编辑最后一条", async () => {
    const api = apiForPanel({
      listChartMarks: vi.fn(async () => [
        chartMark({ markId: "mark-old", comment: "较早记录", revision: 1 }),
        chartMark({ markId: "mark-latest", comment: "最新记录", revision: 2, createdAt: "2026-08-10T11:00:00+08:00" }),
      ]),
    });
    const { user } = renderPanel(api);

    await user.click(await screen.findByRole("button", { name: /登海种业/ }));
    await user.click(await screen.findByRole("button", { name: "选择K线" }));
    await user.click(screen.getByRole("button", { name: "理想买" }));

    expect(screen.getByLabelText("评论")).toHaveValue("最新记录");
    expect(screen.getByRole("button", { name: "保存修改" })).toBeInTheDocument();
  });

  it("30 分钟图按投影规则列出当前柱的 BS 分析", async () => {
    const api = apiForPanel({
      getBsChart: vi.fn(async (symbol: string, timeframe: "1d" | "30m") => (
        timeframe === "30m"
          ? dailyChart(symbol, {
              timeframe: "30m",
              bars: [
                bar({ tradeDate: "2026-08-10", occurredAt: "2026-08-10T10:00:00+08:00" }),
                bar({ tradeDate: "2026-08-10", occurredAt: "2026-08-10T10:30:00+08:00" }),
              ],
              executions: [],
            })
          : dailyChart(symbol)
      )),
      listChartMarks: vi.fn(async () => [
        chartMark({ markId: "mark-daily", comment: "日线分析" }),
        chartMark({ markId: "mark-opening", occurredAt: "2026-08-10T10:00:00+08:00", comment: "开盘分析" }),
      ]),
    });
    const { user } = renderPanel(api);

    await user.click(await screen.findByRole("button", { name: /登海种业/ }));
    await user.click(screen.getByRole("button", { name: "30分钟" }));
    await user.click(await screen.findByRole("button", { name: "选择K线" }));

    const analyses = screen.getByRole("list", { name: "当前 K 线的 BS 分析" });
    expect(analyses).toHaveTextContent("日线分析");
    expect(analyses).not.toHaveTextContent("开盘分析");
  });

  it("可以修改已有 BS 分析的类型和评论", async () => {
    const existing = chartMark();
    const updated = chartMark({ typeId: "type-review", comment: "二次确认", revision: 4 });
    const api = apiForPanel({
      listChartMarks: vi.fn(async () => [existing]),
      updateChartMark: vi.fn(async () => updated),
    });
    const { user } = renderPanel(api);

    await user.click(await screen.findByRole("button", { name: /登海种业/ }));
    await user.click(await screen.findByRole("button", { name: "选择K线" }));
    await user.click(screen.getByRole("button", { name: "编辑分析 回踩确认" }));
    await user.click(screen.getByRole("button", { name: "复盘点" }));
    await user.clear(screen.getByLabelText("评论"));
    await user.type(screen.getByLabelText("评论"), "二次确认");
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    await waitFor(() => expect(api.updateChartMark).toHaveBeenCalledWith("mark-existing", {
      typeId: "type-review",
      comment: "二次确认",
    }, 3));
    expect(screen.getByRole("list", { name: "当前 K 线的 BS 分析" })).toHaveTextContent("二次确认");
  });

  it("二次确认后可以删除已有 BS 分析", async () => {
    const api = apiForPanel({
      listChartMarks: vi.fn(async () => [chartMark()]),
      deleteChartMark: vi.fn(async () => undefined),
    });
    const { user } = renderPanel(api);

    await user.click(await screen.findByRole("button", { name: /登海种业/ }));
    await user.click(await screen.findByRole("button", { name: "选择K线" }));
    await user.click(screen.getByRole("button", { name: "删除分析 回踩确认" }));
    expect(api.deleteChartMark).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "确认删除 回踩确认" }));

    await waitFor(() => expect(api.deleteChartMark).toHaveBeenCalledWith("mark-existing", 3));
    expect(screen.getByRole("list", { name: "当前 K 线的 BS 分析" })).not.toHaveTextContent("回踩确认");
  });

  it("30 分钟行情不可用时展示空态，切回日线仍加载日线", async () => {
    const { api, user } = renderPanel();

    await user.click(await screen.findByRole("button", { name: /登海种业/ }));
    expect(await screen.findByTestId("bs-chart")).toBeInTheDocument();
    expect(api.getBsChart).toHaveBeenCalledWith("002041.SZ", "1d", PERIOD_START, PERIOD_END);

    await user.click(screen.getByRole("button", { name: "30分钟" }));
    expect(await screen.findByText("行情不可用")).toBeInTheDocument();
    expect(screen.queryByTestId("bs-chart")).not.toBeInTheDocument();
    expect(api.getBsChart).toHaveBeenCalledWith("002041.SZ", "30m", PERIOD_START, PERIOD_END);

    await user.click(screen.getByRole("button", { name: "日线" }));
    expect(await screen.findByTestId("bs-chart")).toBeInTheDocument();
    expect(screen.queryByText("行情不可用")).not.toBeInTheDocument();
    expect(api.getBsChart).toHaveBeenCalledWith("002041.SZ", "1d", PERIOD_START, PERIOD_END);
  });

  it("切换日线/30分钟时关闭图标注记，不把日线 occurredAt 提交为 30 分钟", async () => {
    const api = apiForPanel({
      getBsChart: vi.fn(async (symbol: string, timeframe: "1d" | "30m") => (
        timeframe === "30m"
          ? {
            ...dailyChart(symbol),
            timeframe: "30m" as const,
            bars: [
              bar({ tradeDate: "2026-08-10", occurredAt: "2026-08-10T10:00:00+08:00" }),
              bar({ tradeDate: "2026-08-10", occurredAt: "2026-08-10T10:30:00+08:00" }),
            ],
            executions: [],
          }
          : dailyChart(symbol)
      )),
    });
    const { user } = renderPanel(api);

    await user.click(await screen.findByRole("button", { name: /登海种业/ }));
    await user.click(await screen.findByRole("button", { name: "选择K线" }));
    const picker = await screen.findByRole("form", { name: "图标注记" });
    await user.click(screen.getByRole("button", { name: "理想买" }));
    expect(captured.props?.highlightOccurredAt).toBe(BAR_AT);

    await user.click(screen.getByRole("button", { name: "30分钟" }));
    expect(await screen.findByTestId("bs-chart")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "图标注记" })).not.toBeInTheDocument();
    expect(captured.props?.highlightOccurredAt).toBeNull();
    expect(api.createChartMark).not.toHaveBeenCalled();
    expect(vi.mocked(api.createChartMark).mock.calls.some((call) => (
      call[0].timeframe === "30m" && call[0].occurredAt === BAR_AT
    ))).toBe(false);
  });

  it("行情不可用时关闭图标注记并清掉 highlight", async () => {
    const { api, user } = renderPanel();

    await user.click(await screen.findByRole("button", { name: /登海种业/ }));
    await user.click(await screen.findByRole("button", { name: "选择K线" }));
    expect(await screen.findByRole("form", { name: "图标注记" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "30分钟" }));
    expect(await screen.findByText("行情不可用")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "图标注记" })).not.toBeInTheDocument();
    expect(captured.props?.highlightOccurredAt ?? null).toBeNull();
    expect(api.createChartMark).not.toHaveBeenCalled();
  });

  it("点 K 线后可关闭图标注记，不保存手标", async () => {
    const { api, user } = renderPanel();

    await user.click(await screen.findByRole("button", { name: /登海种业/ }));
    await user.click(await screen.findByRole("button", { name: "选择K线" }));
    const picker = await screen.findByRole("form", { name: "图标注记" });

    await user.click(within(picker).getByRole("button", { name: "关闭" }));

    expect(screen.queryByRole("form", { name: "图标注记" })).not.toBeInTheDocument();
    expect(api.createChartMark).not.toHaveBeenCalled();
    expect(captured.props?.highlightOccurredAt).toBeNull();
  });

  it("新建类型可取消，不必创建就能退出类型表单", async () => {
    const { api, user } = renderPanel();

    await user.click(await screen.findByRole("button", { name: /登海种业/ }));
    await user.click(await screen.findByRole("button", { name: "选择K线" }));
    await user.click(await screen.findByRole("button", { name: "+ 新类型" }));
    await user.type(screen.getByLabelText("名称"), "突破");

    await user.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.queryByLabelText("名称")).not.toBeInTheDocument();
    expect(api.createChartMarkType).not.toHaveBeenCalled();
    expect(api.createChartMark).not.toHaveBeenCalled();
  });

  it("未保存评论按股票、周期和 K 线保留，关闭再打开也能恢复", async () => {
    const api = apiForPanel({
      getBsChart: vi.fn(async (symbol: string, timeframe: "1d" | "30m") => dailyChart(symbol, { timeframe })),
    });
    const { user } = renderPanel(api);

    await user.click(await screen.findByRole("button", { name: /登海种业/ }));
    await user.click(await screen.findByRole("button", { name: "选择K线" }));
    await user.click(screen.getByRole("button", { name: "复盘点" }));
    await user.type(screen.getByLabelText("评论"), "等待回踩\n缩量再看");
    expect(screen.getByText("未保存")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "选择K线 8月14日" }));
    expect(screen.getByLabelText("评论")).toHaveValue("");
    await user.type(screen.getByLabelText("评论"), "另一根 K 线");
    await user.click(screen.getByRole("button", { name: "选择K线" }));
    expect(screen.getByLabelText("评论")).toHaveValue("等待回踩\n缩量再看");
    expect(screen.getByRole("button", { name: "复盘点" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "30分钟" }));
    await user.click(await screen.findByRole("button", { name: "选择K线" }));
    expect(screen.getByLabelText("评论")).toHaveValue("");
    await user.type(screen.getByLabelText("评论"), "分钟草稿");
    await user.click(screen.getByRole("button", { name: "日线" }));
    await user.click(await screen.findByRole("button", { name: "选择K线" }));
    expect(screen.getByLabelText("评论")).toHaveValue("等待回踩\n缩量再看");

    await user.click(screen.getByRole("button", { name: /平安银行/ }));
    await user.click(await screen.findByRole("button", { name: "选择K线" }));
    expect(screen.getByLabelText("评论")).toHaveValue("");
    await user.type(screen.getByLabelText("评论"), "银行草稿");
    await user.click(screen.getByRole("button", { name: /登海种业/ }));
    await user.click(await screen.findByRole("button", { name: "选择K线" }));
    expect(screen.getByLabelText("评论")).toHaveValue("等待回踩\n缩量再看");

    await user.click(screen.getByRole("button", { name: "关闭" }));
    await user.click(screen.getByRole("button", { name: "选择K线" }));
    expect(screen.getByLabelText("评论")).toHaveValue("等待回踩\n缩量再看");
    expect(api.createChartMark).not.toHaveBeenCalled();
  });

  it("新增分析保存期间防止重复提交，完成后显示已保存", async () => {
    let finishSave!: (mark: ChartMark) => void;
    const api = apiForPanel({
      createChartMark: vi.fn(() => new Promise<ChartMark>((resolve) => { finishSave = resolve; })),
    });
    const { user } = renderPanel(api);
    await user.click(await screen.findByRole("button", { name: /登海种业/ }));
    await user.click(await screen.findByRole("button", { name: "选择K线" }));
    await user.type(screen.getByLabelText("评论"), "保存这段评论");
    await user.dblClick(screen.getByRole("button", { name: "新增分析" }));

    expect(api.createChartMark).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "保存中…" })).toBeDisabled();
    expect(screen.getByLabelText("评论")).toBeDisabled();
    await act(async () => { finishSave(chartMark({ comment: "保存这段评论", revision: 1 })); });
    expect(screen.getByText("已保存")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存修改" })).toBeEnabled();
    await user.type(screen.getByLabelText("评论"), "补充");
    expect(screen.getByText("未保存")).toBeInTheDocument();
  });

  it("修改失败保留草稿和编辑目标，切换后可以继续重试", async () => {
    const api = apiForPanel({
      listChartMarks: vi.fn(async () => [chartMark()]),
      updateChartMark: vi.fn().mockRejectedValueOnce(new Error("保存失败，请重试")).mockResolvedValueOnce(chartMark({ comment: "新的复盘", revision: 4 })),
    });
    const { user } = renderPanel(api);
    await user.click(await screen.findByRole("button", { name: /登海种业/ }));
    await user.click(await screen.findByRole("button", { name: "选择K线" }));
    await user.click(screen.getByRole("button", { name: "编辑分析 回踩确认" }));
    await user.clear(screen.getByLabelText("评论"));
    await user.type(screen.getByLabelText("评论"), "新的复盘");
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("保存失败，请重试");
    expect(screen.getByLabelText("评论")).toHaveValue("新的复盘");
    await user.click(screen.getByRole("button", { name: "选择K线 8月14日" }));
    await user.click(screen.getByRole("button", { name: "选择K线" }));
    expect(screen.getByLabelText("评论")).toHaveValue("新的复盘");
    await user.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(api.updateChartMark).toHaveBeenCalledTimes(2));
    expect(api.updateChartMark).toHaveBeenLastCalledWith("mark-existing", { comment: "新的复盘" }, 3);
    expect(screen.getByText("已保存")).toBeInTheDocument();
  });

  it("保存返回时已切换股票，不覆盖当前股票的草稿或标注", async () => {
    let finishSave!: (mark: ChartMark) => void;
    const api = apiForPanel({
      listChartMarks: vi.fn(async () => []),
      createChartMark: vi.fn(() => new Promise<ChartMark>((resolve) => { finishSave = resolve; })),
    });
    const { user } = renderPanel(api);
    await user.click(await screen.findByRole("button", { name: /登海种业/ }));
    await user.click(await screen.findByRole("button", { name: "选择K线" }));
    await user.type(screen.getByLabelText("评论"), "登海分析");
    await user.click(screen.getByRole("button", { name: "新增分析" }));
    await user.click(screen.getByRole("button", { name: /平安银行/ }));
    await user.click(await screen.findByRole("button", { name: "选择K线" }));
    await user.type(screen.getByLabelText("评论"), "银行分析");

    await act(async () => { finishSave(chartMark({ comment: "登海分析", revision: 1 })); });
    expect(screen.getByLabelText("评论")).toHaveValue("银行分析");
    expect(captured.props?.marks).toEqual([]);
    expect(screen.getByRole("button", { name: "新增分析" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /登海种业/ }));
    await user.click(await screen.findByRole("button", { name: "选择K线" }));
    expect(screen.getByLabelText("评论")).toHaveValue("登海分析");
    expect(screen.getByText("已保存")).toBeInTheDocument();
  });

  it("删除期间防重复提交，失败保留正在编辑的文字", async () => {
    let failDelete!: (reason: Error) => void;
    const api = apiForPanel({
      listChartMarks: vi.fn(async () => [chartMark()]),
      deleteChartMark: vi.fn(() => new Promise<void>((_resolve, reject) => { failDelete = reject; })),
    });
    const { user } = renderPanel(api);
    await user.click(await screen.findByRole("button", { name: /登海种业/ }));
    await user.click(await screen.findByRole("button", { name: "选择K线" }));
    await user.click(screen.getByRole("button", { name: "编辑分析 回踩确认" }));
    await user.type(screen.getByLabelText("评论"), "待补充");
    await user.click(screen.getByRole("button", { name: "删除分析 回踩确认" }));
    await user.dblClick(screen.getByRole("button", { name: "确认删除 回踩确认" }));

    expect(api.deleteChartMark).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "删除中…" })).toBeDisabled();
    await act(async () => { failDelete(new Error("删除失败")); });
    expect(await screen.findByRole("alert")).toHaveTextContent("删除失败");
    expect(screen.getByLabelText("评论")).toHaveValue("回踩确认待补充");
    expect(screen.getByRole("list", { name: "当前 K 线的 BS 分析" })).toHaveTextContent("回踩确认");
  });

  it("创建类型期间防重复提交，失败后保留类型字段", async () => {
    let failCreate!: (reason: Error) => void;
    const api = apiForPanel({
      createChartMarkType: vi.fn(() => new Promise<ChartMarkType>((_resolve, reject) => { failCreate = reject; })),
    });
    const { user } = renderPanel(api);
    await user.click(await screen.findByRole("button", { name: /登海种业/ }));
    await user.click(await screen.findByRole("button", { name: "选择K线" }));
    await user.click(screen.getByRole("button", { name: "+ 新类型" }));
    await user.type(screen.getByLabelText("名称"), "突破");
    await user.type(screen.getByLabelText("字母"), "突");
    await user.dblClick(screen.getByRole("button", { name: "创建类型" }));

    expect(api.createChartMarkType).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "创建中…" })).toBeDisabled();
    await act(async () => { failCreate(new Error("类型创建失败")); });
    expect(await screen.findByRole("alert")).toHaveTextContent("类型创建失败");
    expect(screen.getByLabelText("名称")).toHaveValue("突破");
    expect(screen.getByLabelText("字母")).toHaveValue("突");
    expect(screen.getByRole("button", { name: "创建类型" })).toBeEnabled();
  });
});
