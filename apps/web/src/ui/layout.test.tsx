import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { EmptyState } from "./EmptyState";
import { Notice } from "./Notice";
import { Panel } from "./Panel";
import { SegmentedControl } from "./SegmentedControl";
import { SplitPane } from "./SplitPane";

it("keeps notice as an alert with a lucide icon instead of a bang", () => {
  render(<Notice title="数据服务暂不可用" detail="upstream" />);
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent("数据服务暂不可用");
  expect(alert.querySelector("svg")).not.toBeNull();
  expect(alert.textContent).not.toContain("!");
  expect(alert.querySelector(":scope > span")).toBeNull();
  expect(alert.querySelector(":scope > div span")).toHaveTextContent("upstream");
});

it("renders empty copy and split children", () => {
  render(<SplitPane left={<Panel title="左">L</Panel>} right={<EmptyState title="该周期还没有固化报告。" />} />);
  expect(screen.getByText("左")).toBeInTheDocument();
  expect(screen.getByText("该周期还没有固化报告。")).toBeInTheDocument();
});

it("wraps split slots so fragment children do not become extra grid items", () => {
  const { container } = render(
    <SplitPane
      left={<span>L</span>}
      right={
        <>
          <span>R1</span>
          <span>R2</span>
        </>
      }
    />,
  );
  const split = container.querySelector(".ui-split");
  expect(split).not.toBeNull();
  expect(Array.from(split!.children)).toHaveLength(2);
  expect(split!.children[0].className).toBe("ui-split-pane");
  expect(split!.children[1].className).toBe("ui-split-pane");
  expect(split!.children[1].querySelectorAll(":scope > span")).toHaveLength(2);
});

it("spreads root attributes on Panel and SegmentedControl", () => {
  render(
    <>
      <Panel title="表单" as="form" aria-label="创建交易账户" onSubmit={(event) => event.preventDefault()}>
        ok
      </Panel>
      <SegmentedControl aria-label="周期">
        <button type="button" aria-pressed="true">
          周报
        </button>
      </SegmentedControl>
    </>,
  );
  expect(screen.getByRole("form", { name: "创建交易账户" })).toBeInTheDocument();
  expect(screen.getByLabelText("周期")).toHaveClass("ui-segment");
});
