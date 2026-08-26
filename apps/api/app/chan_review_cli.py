from __future__ import annotations

import argparse
import json
from datetime import UTC, date, datetime
from pathlib import Path

from .chan_review import ChanReviewService
from .chan_review_render import render_review_png, render_review_svg
from .db import Database
from .providers.factory import create_market_provider
from .stock_universe import StockUniverseService


def main() -> None:
    parser = argparse.ArgumentParser(description="从 Tushare 缓存链路生成缠论多周期分析")
    parser.add_argument("--query", required=True, help="股票名称、拼音或代码")
    parser.add_argument("--as-of", dest="as_of", default=None)
    parser.add_argument("--out", required=True, help="输出前缀，不含扩展名")
    args = parser.parse_args()
    as_of = date.fromisoformat(args.as_of) if args.as_of else datetime.now(UTC).date()
    database = Database()
    provider = create_market_provider()
    universe = StockUniverseService(database, provider)
    matches = universe.search(args.query, limit=8)
    if not matches:
        print(json.dumps({"status": "missing", "query": args.query}, ensure_ascii=False))
        return
    if len(matches) > 1 and not _unique(args.query, matches):
        print(json.dumps({"status": "ambiguous", "matches": matches}, ensure_ascii=False))
        return
    chosen = matches[0]
    payload = ChanReviewService(provider, database).review(
        chosen["symbol"],
        as_of=as_of,
        name=chosen["name"],
    )
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    json_path = out.with_suffix(".json")
    json_path.write_text(json.dumps(payload, ensure_ascii=False, default=str), encoding="utf-8")
    svg_path = render_review_svg(payload, out.with_suffix(".svg"))
    png_path = render_review_png(payload, out.with_suffix(".png"))
    print(
        json.dumps(
            {
                "status": "ok",
                "symbol": chosen["symbol"],
                "name": chosen["name"],
                "as_of": as_of.isoformat(),
                "json_path": str(json_path),
                "svg_path": svg_path,
                "png_path": png_path,
            },
            ensure_ascii=False,
        )
    )


def _unique(query: str, matches: list[dict]) -> bool:
    needle = query.strip().upper()
    return len([item for item in matches if item["symbol"] == needle or item["symbol"].startswith(needle)]) == 1


if __name__ == "__main__":
    main()
