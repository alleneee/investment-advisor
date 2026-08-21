import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { EmptyState } from "./EmptyState";
import { Notice } from "./Notice";
import { Panel } from "./Panel";
import { SplitPane } from "./SplitPane";

it("keeps notice as an alert with a lucide icon instead of a bang", () => {
  render(<Notice title="数据服务暂不可用" detail="upstream" />);
  expect(screen.getByRole("alert")).toHaveTextContent("数据服务暂不可用");
  expect(screen.getByRole("alert").querySelector("svg")).not.toBeNull();
  expect(screen.getByRole("alert").textContent).not.toContain("!");
});

it("renders empty copy and split children", () => {
  render(<SplitPane left={<Panel title="左">L</Panel>} right={<EmptyState title="该周期还没有固化报告。" />} />);
  expect(screen.getByText("左")).toBeInTheDocument();
  expect(screen.getByText("该周期还没有固化报告。")).toBeInTheDocument();
});
