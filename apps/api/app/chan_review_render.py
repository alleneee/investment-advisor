from __future__ import annotations

import json
from pathlib import Path
from typing import Any


FRAME_ORDER = ("1M", "1w", "1d", "60m", "30m", "15m")
FRAME_TITLE = {"1M": "月线", "1w": "周线", "1d": "日线", "60m": "60分钟", "30m": "30分钟", "15m": "15分钟"}


def render_review_svg(payload: dict[str, Any], dest: str | Path) -> str:
    dest_path = Path(dest)
    panels = []
    width, height, pad = 1200, 420, 40
    for index, timeframe in enumerate(FRAME_ORDER):
        frame = payload.get("frames", {}).get(timeframe) or {}
        y = index * (height + 24)
        panels.append(_panel_svg(frame, timeframe, 0, y, width, height, pad))
    total_height = len(FRAME_ORDER) * (height + 24)
    title = (
        f"{payload.get('name', '')} {payload.get('symbol', '')} "
        f"as_of {payload.get('as_of', '')} 来源 {payload.get('source', '')} "
        f"复权 {payload.get('adjustment', '')}"
    )
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{total_height + 48}" '
        f'style="background:#101920">'
        f'<text x="24" y="28" fill="#eef4f0" font-size="16">{_esc(title)}</text>'
        + "".join(panels)
        + "</svg>"
    )
    dest_path.write_text(svg, encoding="utf-8")
    return str(dest_path)


def render_review_png(payload: dict[str, Any], dest: str | Path) -> str | None:
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from matplotlib.patches import Rectangle
        from matplotlib.collections import PatchCollection
    except ImportError:
        return None
    dest_path = Path(dest)
    fig, axes = plt.subplots(3, 2, figsize=(16, 18), facecolor="#101920")
    fig.suptitle(
        f"{payload.get('name', '')} {payload.get('symbol', '')}  {payload.get('as_of', '')}  "
        f"{payload.get('source', '')} / {payload.get('adjustment', '')}",
        color="#eef4f0",
        fontsize=14,
    )
    for axis, timeframe in zip(axes.ravel(), FRAME_ORDER, strict=True):
        axis.set_facecolor("#101920")
        axis.tick_params(colors="#8a9b96")
        axis.set_title(FRAME_TITLE[timeframe], color="#eef4f0")
        frame = payload.get("frames", {}).get(timeframe) or {}
        bars = frame.get("bars") or []
        if not frame.get("available") or not bars:
            axis.text(0.5, 0.5, "无数据", color="#8a9b96", ha="center", va="center", transform=axis.transAxes)
            continue
        for index, bar in enumerate(bars):
            open_, close = float(bar["open"]), float(bar["close"])
            high, low = float(bar["high"]), float(bar["low"])
            color = "#f6465d" if close >= open_ else "#0ecb81"
            axis.vlines(index, low, high, colors=color, linewidth=0.8)
            axis.add_patch(Rectangle((index - 0.35, min(open_, close)), 0.7, max(abs(close - open_), 0.01), color=color))
        snapshot = frame.get("snapshot") or {}
        dates = [str(item.get("occurred_at", ""))[:10] for item in snapshot.get("bars") or []]
        date_index = {value: index for index, value in enumerate(dates)}
        for center in snapshot.get("segment_centers") or snapshot.get("centers") or []:
            start = _index_of(center.get("start_index"), dates, date_index, center.get("occurred_at"))
            end = _index_of(center.get("end_index"), dates, date_index, center.get("occurred_at"))
            if start is None or end is None:
                continue
            lower, upper = float(center["lower"]), float(center["upper"])
            axis.add_patch(Rectangle((start, lower), max(end - start, 1), upper - lower, facecolor="#e89548", alpha=0.2, edgecolor="#e89548"))
        axis.set_xlim(-1, max(len(bars), 1))
    fig.tight_layout()
    fig.savefig(dest_path, dpi=120, facecolor=fig.get_facecolor())
    plt.close(fig)
    return str(dest_path)


def _index_of(raw_index: Any, dates: list[str], date_index: dict[str, int], occurred_at: Any) -> int | None:
    if isinstance(raw_index, int) and 0 <= raw_index < len(dates):
        return raw_index
    key = str(occurred_at or "")[:10]
    return date_index.get(key)


def _panel_svg(frame: dict[str, Any], timeframe: str, x: int, y: int, width: int, height: int, pad: int) -> str:
    title = FRAME_TITLE[timeframe]
    if not frame.get("available"):
        warning = "；".join((frame.get("quality") or {}).get("warnings") or ["无数据"])
        return (
            f'<g transform="translate({x},{y + 48})">'
            f'<text x="{pad}" y="24" fill="#eef4f0" font-size="14">{title}</text>'
            f'<text x="{pad}" y="56" fill="#8a9b96" font-size="12">{_esc(warning)}</text></g>'
        )
    bars = frame.get("bars") or []
    inner_w, inner_h = width - pad * 2, height - 70
    highs = [float(item["high"]) for item in bars] or [1]
    lows = [float(item["low"]) for item in bars] or [0]
    min_p, max_p = min(lows), max(highs)
    span = max(max_p - min_p, 0.01)
    def px(index: int, price: float) -> tuple[float, float]:
        return (
            pad + index * inner_w / max(len(bars) - 1, 1),
            50 + (max_p - price) / span * inner_h,
        )
    parts = [f'<g transform="translate({x},{y + 48})"><text x="{pad}" y="24" fill="#eef4f0" font-size="14">{title} {len(bars)}根</text>']
    for index, bar in enumerate(bars):
        x0, y_high = px(index, float(bar["high"]))
        _, y_low = px(index, float(bar["low"]))
        _, y_open = px(index, float(bar["open"]))
        _, y_close = px(index, float(bar["close"]))
        color = "#f6465d" if float(bar["close"]) >= float(bar["open"]) else "#0ecb81"
        parts.append(f'<line x1="{x0}" y1="{y_high}" x2="{x0}" y2="{y_low}" stroke="{color}" stroke-width="1"/>')
        top, bottom = min(y_open, y_close), max(y_open, y_close)
        parts.append(f'<rect x="{x0 - 1.5}" y="{top}" width="3" height="{max(bottom - top, 1)}" fill="{color}"/>')
    parts.append("</g>")
    return "".join(parts)


def _esc(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("json_path")
    parser.add_argument("dest_prefix")
    args = parser.parse_args()
    payload = json.loads(Path(args.json_path).read_text(encoding="utf-8"))
    svg_path = render_review_svg(payload, f"{args.dest_prefix}.svg")
    png_path = render_review_png(payload, f"{args.dest_prefix}.png")
    print(json.dumps({"svg": svg_path, "png": png_path}, ensure_ascii=False))
