import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { KpiStrip } from "./KpiStrip";
import { MetricTile } from "./MetricTile";
import { StatusChip } from "./StatusChip";

it("colors pnl red for gains and green for losses", () => {
  const { rerender } = render(<MetricTile label="当日盈亏" value="+350.50" tone="up" />);
  expect(screen.getByText("+350.50").className).toMatch(/tone-up/);
  rerender(<MetricTile label="当日盈亏" value="-1,280.00" tone="down" />);
  expect(screen.getByText("-1,280.00").className).toMatch(/tone-down/);
  rerender(<MetricTile label="回撤" value="-3.25%" tone="risk" detail="成立以来" />);
  expect(screen.getByText("-3.25%").className).toMatch(/tone-risk/);
  expect(screen.getByText("成立以来")).toBeInTheDocument();
});

it("allows a status chip as a kpi value", () => {
  render(<KpiStrip><MetricTile label="本批状态" value={<StatusChip tone="risk" label="降级" />} /></KpiStrip>);
  expect(screen.getByText("降级")).toBeInTheDocument();
});
