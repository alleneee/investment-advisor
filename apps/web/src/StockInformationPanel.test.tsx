import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StockInformationPanel } from "./StockInformationPanel";
import type { StockInformation } from "./types";

function information(): StockInformation {
  return {
    symbol: "002940.SZ",
    snapshotId: "information-1",
    generatedAt: "2026-08-13T09:00:00+08:00",
    news: [{
      id: "news-1",
      title: "公司发布经营进展",
      summary: "经营保持稳定",
      publishedAt: "2026-08-13T08:00:00+08:00",
      source: "东财",
      url: "https://example.com/news/1",
    }],
    messages: [{
      id: "irm-1",
      question: "产能进展如何？",
      answer: "按计划推进。",
      answerer: "证券部",
      publishedAt: "2026-08-12T16:00:00+08:00",
      source: "cninfo",
    }],
    sentiment: {
      hotRank: 8,
      heat: 9123,
      rankChange: 2,
      concepts: ["机器人", "专精特新"],
      tag: "热股",
      observedAt: "2026-08-13T09:00:00+08:00",
    },
    quality: {
      status: "ok",
      warnings: [],
      sources: {
        eastmoneyNews: { status: "fresh", fetchedAt: "2026-08-13T09:00:00+08:00" },
        cninfoIrm: { status: "cached", fetchedAt: "2026-08-13T08:00:00+08:00" },
        thsHotList: { status: "fresh", fetchedAt: "2026-08-13T09:00:00+08:00" },
      },
    },
  };
}

describe("StockInformationPanel", () => {
  it("shows news, investor messages, and the hot-list snapshot", () => {
    render(<StockInformationPanel information={information()} />);

    expect(screen.getByRole("heading", { name: "公司发布经营进展" })).toBeInTheDocument();
    expect(screen.getByText("经营保持稳定")).toBeInTheDocument();
    expect(screen.getByText("产能进展如何？")).toBeInTheDocument();
    expect(screen.getByText("按计划推进。")).toBeInTheDocument();
    expect(screen.getByText("热榜 #8")).toBeInTheDocument();
    expect(screen.getByText("机器人")).toBeInTheDocument();
  });

  it("shows an explicit empty state", () => {
    const empty = information();
    empty.news = [];
    empty.messages = [];
    empty.sentiment = { hotRank: null, heat: null, rankChange: null, concepts: [], tag: null, observedAt: null };

    render(<StockInformationPanel information={empty} />);

    expect(screen.getByText("暂无可用资讯证据")).toBeInTheDocument();
  });

  it("keeps degraded source warnings local to the panel", () => {
    const degraded = information();
    degraded.quality.status = "degraded";
    degraded.quality.warnings = ["eastmoney_news 数据源状态为 unavailable"];

    render(<StockInformationPanel information={degraded} />);

    expect(screen.getByRole("status")).toHaveTextContent("资讯来源部分降级");
    expect(screen.getByRole("status")).toHaveTextContent("eastmoney_news 数据源状态为 unavailable");
  });

  it("opens only safe external links in a new tab", () => {
    const safe = information();
    const { rerender } = render(<StockInformationPanel information={safe} />);

    expect(screen.getByRole("link", { name: "公司发布经营进展" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "公司发布经营进展" })).toHaveAttribute("rel", "noreferrer");

    safe.news[0].url = "javascript:alert(1)";
    rerender(<StockInformationPanel information={safe} />);

    expect(screen.queryByRole("link", { name: "公司发布经营进展" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "公司发布经营进展" })).toBeInTheDocument();
  });
});
