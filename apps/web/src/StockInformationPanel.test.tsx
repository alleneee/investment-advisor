import { fireEvent, render, screen } from "@testing-library/react";
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

function longInformation(): StockInformation {
  const value = information();
  value.news = [
    {
      id: "news-1",
      title: "公司新闻 1",
      summary: "新闻摘要 1",
      publishedAt: "2026-08-13T08:00:00+08:00",
      source: "东财",
      url: "https://example.com/news/1",
    },
    {
      id: "news-2",
      title: "公司新闻 2",
      summary: "新闻摘要 2",
      publishedAt: "2026-08-13T07:00:00+08:00",
      source: "东财",
      url: "https://example.com/news/2",
    },
    {
      id: "news-3",
      title: "公司新闻 3",
      summary: "新闻摘要 3",
      publishedAt: "2026-08-13T06:00:00+08:00",
      source: "东财",
      url: "https://example.com/news/3",
    },
    {
      id: "news-4",
      title: "公司新闻 4",
      summary: "新闻摘要 4",
      publishedAt: "2026-08-13T05:00:00+08:00",
      source: "东财",
      url: "https://example.com/news/4",
    },
    {
      id: "news-5",
      title: "公司新闻 5",
      summary: "新闻摘要 5",
      publishedAt: "2026-08-13T04:00:00+08:00",
      source: "东财",
      url: "https://example.com/news/5",
    },
    {
      id: "news-6",
      title: "公司新闻 6",
      summary: "新闻摘要 6",
      publishedAt: "2026-08-13T03:00:00+08:00",
      source: "东财",
      url: "https://example.com/news/6",
    },
  ];
  value.messages = [
    {
      id: "irm-1",
      question: "互动问答 1",
      answer: "问答回复 1",
      answerer: "证券部",
      publishedAt: "2026-08-12T16:00:00+08:00",
      source: "cninfo",
    },
    {
      id: "irm-2",
      question: "互动问答 2",
      answer: "问答回复 2",
      answerer: "证券部",
      publishedAt: "2026-08-12T15:00:00+08:00",
      source: "cninfo",
    },
    {
      id: "irm-3",
      question: "互动问答 3",
      answer: "问答回复 3",
      answerer: "证券部",
      publishedAt: "2026-08-12T14:00:00+08:00",
      source: "cninfo",
    },
    {
      id: "irm-4",
      question: "互动问答 4",
      answer: "问答回复 4",
      answerer: "证券部",
      publishedAt: "2026-08-12T13:00:00+08:00",
      source: "cninfo",
    },
    {
      id: "irm-5",
      question: "互动问答 5",
      answer: "问答回复 5",
      answerer: "证券部",
      publishedAt: "2026-08-12T12:00:00+08:00",
      source: "cninfo",
    },
    {
      id: "irm-6",
      question: "互动问答 6",
      answer: "问答回复 6",
      answerer: "证券部",
      publishedAt: "2026-08-12T11:00:00+08:00",
      source: "cninfo",
    },
  ];
  return value;
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

  it("shows only four news and four messages by default", () => {
    render(<StockInformationPanel information={longInformation()} />);

    expect(screen.getByRole("heading", { name: "公司新闻 4" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "公司新闻 5" })).not.toBeInTheDocument();
    expect(screen.getByText("互动问答 4")).toBeInTheDocument();
    expect(screen.queryByText("互动问答 5")).not.toBeInTheDocument();
    expect(screen.getAllByText("04 / 06")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "展开全部新闻（还有 2 条）" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "展开全部问答（还有 2 条）" })).toHaveAttribute("aria-expanded", "false");
  });

  it("expands and collapses news and messages independently", () => {
    render(<StockInformationPanel information={longInformation()} />);

    fireEvent.click(screen.getByRole("button", { name: "展开全部新闻（还有 2 条）" }));

    expect(screen.getByRole("heading", { name: "公司新闻 6" })).toBeInTheDocument();
    expect(screen.queryByText("互动问答 5")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起全部新闻" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "展开全部问答（还有 2 条）" })).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "展开全部问答（还有 2 条）" }));

    expect(screen.getByText("互动问答 6")).toBeInTheDocument();
    expect(screen.getAllByText("06 / 06")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "收起全部问答" })).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByRole("button", { name: "收起全部新闻" }));

    expect(screen.queryByRole("heading", { name: "公司新闻 5" })).not.toBeInTheDocument();
    expect(screen.getByText("互动问答 6")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开全部新闻（还有 2 条）" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "收起全部问答" })).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByRole("button", { name: "收起全部问答" }));

    expect(screen.queryByText("互动问答 5")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开全部问答（还有 2 条）" })).toHaveAttribute("aria-expanded", "false");
  });

  it("does not show expand buttons for feeds with no more than four items", () => {
    render(<StockInformationPanel information={information()} />);

    expect(screen.queryByRole("button", { name: /全部新闻/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /全部问答/ })).not.toBeInTheDocument();
    expect(screen.getAllByText("01 / 01")).toHaveLength(2);
  });

  it("collapses both feeds when the information symbol changes", () => {
    const { rerender } = render(<StockInformationPanel information={longInformation()} />);
    fireEvent.click(screen.getByRole("button", { name: "展开全部新闻（还有 2 条）" }));
    fireEvent.click(screen.getByRole("button", { name: "展开全部问答（还有 2 条）" }));
    const nextInformation = longInformation();
    nextInformation.symbol = "600519.SH";

    rerender(<StockInformationPanel information={nextInformation} />);

    expect(screen.queryByRole("heading", { name: "公司新闻 5" })).not.toBeInTheDocument();
    expect(screen.queryByText("互动问答 5")).not.toBeInTheDocument();
    expect(screen.getAllByText("04 / 06")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "展开全部新闻（还有 2 条）" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "展开全部问答（还有 2 条）" })).toHaveAttribute("aria-expanded", "false");
  });
});
