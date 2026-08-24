import { useEffect, useState } from "react";
import type { StockInformation, StockNews } from "./types";

const DEFAULT_VISIBLE_INFORMATION_ITEMS = 4;

interface StockInformationPanelProps {
  information: StockInformation | null;
  loading?: boolean;
  error?: string | null;
}

export function StockInformationPanel({ information, loading = false, error = null }: StockInformationPanelProps) {
  const symbol = information?.symbol ?? null;
  const [newsExpansion, setNewsExpansion] = useState({ symbol, expanded: false });
  const [messagesExpansion, setMessagesExpansion] = useState({ symbol, expanded: false });
  useEffect(() => {
    setNewsExpansion({ symbol, expanded: false });
    setMessagesExpansion({ symbol, expanded: false });
  }, [symbol]);
  const newsExpanded = newsExpansion.symbol === symbol && newsExpansion.expanded;
  const messagesExpanded = messagesExpansion.symbol === symbol && messagesExpansion.expanded;
  const visibleNews = information
    ? information.news.slice(0, newsExpanded ? information.news.length : DEFAULT_VISIBLE_INFORMATION_ITEMS)
    : [];
  const visibleMessages = information
    ? information.messages.slice(0, messagesExpanded ? information.messages.length : DEFAULT_VISIBLE_INFORMATION_ITEMS)
    : [];
  const empty = information != null
    && information.news.length === 0
    && information.messages.length === 0
    && information.sentiment.hotRank == null
    && information.sentiment.heat == null
    && information.sentiment.concepts.length === 0;
  return <section className="information-panel" aria-labelledby="information-heading">
    <div className="evidence-panel-header">
      <div>
        <span className="evidence-kicker">INFORMATION SNAPSHOT</span>
        <h3 id="information-heading">资讯证据</h3>
      </div>
      {information && <div className="evidence-timestamp"><span>GENERATED</span><time dateTime={information.generatedAt}>{information.generatedAt}</time></div>}
    </div>
    {loading && !information && <div className="evidence-loading">正在加载资讯证据…</div>}
    {error && <div className="evidence-local-error" role="status"><strong>资讯加载失败</strong><span>{error}</span></div>}
    {information && information.quality.status !== "ok" && <div className={`information-quality ${information.quality.status}`} role="status">
      <strong>{information.quality.status === "degraded" ? "资讯来源部分降级" : "资讯来源当前不可用"}</strong>
      {information.quality.warnings.map((warning) => <span key={warning}>{warning}</span>)}
    </div>}
    {empty && <div className="information-empty">暂无可用资讯证据</div>}
    {information && !empty && <div className="information-grid">
      <div className="information-column news-column">
        <div className="information-column-heading"><span>01</span><strong>公司新闻</strong><small>{visibleNews.length.toString().padStart(2, "0")} / {information.news.length.toString().padStart(2, "0")}</small></div>
        <div className="information-list">
          {information.news.length ? visibleNews.map((item) => <NewsItem item={item} key={item.id} />) : <div className="information-column-empty">暂无新闻</div>}
        </div>
        {information.news.length > DEFAULT_VISIBLE_INFORMATION_ITEMS && <button
          type="button"
          className="information-toggle"
          aria-expanded={newsExpanded}
          onClick={() => setNewsExpansion({ symbol, expanded: !newsExpanded })}
        >{newsExpanded ? "收起全部新闻" : `展开全部新闻（还有 ${information.news.length - DEFAULT_VISIBLE_INFORMATION_ITEMS} 条）`}</button>}
      </div>
      <div className="information-column message-column">
        <div className="information-column-heading"><span>02</span><strong>互动问答</strong><small>{visibleMessages.length.toString().padStart(2, "0")} / {information.messages.length.toString().padStart(2, "0")}</small></div>
        <div className="information-list">
          {information.messages.length ? visibleMessages.map((item) => <article className="message-item" key={item.id}>
            <div className="information-meta"><span>{item.source}</span><time dateTime={item.publishedAt}>{item.publishedAt}</time></div>
            <strong className="message-question">{item.question}</strong>
            <p>{item.answer ?? "尚未回复"}</p>
            {item.answerer && <small>答复方 / {item.answerer}</small>}
          </article>) : <div className="information-column-empty">暂无互动问答</div>}
        </div>
        {information.messages.length > DEFAULT_VISIBLE_INFORMATION_ITEMS && <button
          type="button"
          className="information-toggle"
          aria-expanded={messagesExpanded}
          onClick={() => setMessagesExpansion({ symbol, expanded: !messagesExpanded })}
        >{messagesExpanded ? "收起全部问答" : `展开全部问答（还有 ${information.messages.length - DEFAULT_VISIBLE_INFORMATION_ITEMS} 条）`}</button>}
      </div>
      <div className="information-column sentiment-column">
        <div className="information-column-heading"><span>03</span><strong>市场热度</strong><small>THS</small></div>
        <div className="sentiment-card">
          <div className="sentiment-rank"><span>RANK</span><strong>{information.sentiment.hotRank == null ? "暂无热榜排名" : `热榜 #${information.sentiment.hotRank}`}</strong></div>
          <dl>
            <div><dt>热度</dt><dd>{information.sentiment.heat?.toLocaleString("zh-CN") ?? "—"}</dd></div>
            <div><dt>排名变化</dt><dd>{signedNumber(information.sentiment.rankChange)}</dd></div>
            <div><dt>标签</dt><dd>{information.sentiment.tag ?? "—"}</dd></div>
          </dl>
          {information.sentiment.concepts.length > 0 && <div className="concept-list">{information.sentiment.concepts.map((concept) => <span key={concept}>{concept}</span>)}</div>}
          {information.sentiment.observedAt && <time className="sentiment-time" dateTime={information.sentiment.observedAt}>OBSERVED / {information.sentiment.observedAt}</time>}
        </div>
      </div>
    </div>}
  </section>;
}

function NewsItem({ item }: { item: StockNews }) {
  const href = safeExternalUrl(item.url);
  const heading = <h4>{item.title}</h4>;
  return <article className="news-item">
    <div className="information-meta"><span>{item.source}</span><time dateTime={item.publishedAt}>{item.publishedAt}</time></div>
    {href ? <a href={href} target="_blank" rel="noreferrer">{heading}</a> : heading}
    <p>{item.summary}</p>
  </article>;
}

function safeExternalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function signedNumber(value: number | null): string {
  if (value == null) return "—";
  return value > 0 ? `+${value}` : String(value);
}
