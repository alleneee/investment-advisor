import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { JournalMonthPicker } from "./JournalMonthPicker";

describe("日历月份选择", () => {
  it("打开时聚焦当前月份，选月后通知页面并回到标题", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<JournalMonthPicker value="2026-08" label="2026年8月" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: "选择月份" });
    expect(screen.getByRole("heading", { name: "2026年8月" })).toBeInTheDocument();
    await user.click(trigger);
    const dialog = within(screen.getByRole("dialog", { name: "选择月份" }));
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(dialog.getByRole("button", { name: "8月" })).toHaveFocus();
    expect(dialog.getByRole("button", { name: "8月" })).toHaveAttribute("aria-pressed", "true");

    await user.click(dialog.getByRole("button", { name: "7月" }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith("2026-07");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("切换年份后选择月份，关闭再打开回到当前值所在年份", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<JournalMonthPicker value="2026-08" label="2026年8月" onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "选择月份" }));
    await user.click(screen.getByRole("button", { name: "下一年" }));
    await user.click(screen.getByRole("button", { name: "下一年" }));
    await user.click(screen.getByRole("button", { name: "上一年" }));
    expect(within(screen.getByRole("dialog")).getByText("2027年")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "1月" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("2027-01");

    await user.click(screen.getByRole("button", { name: "选择月份" }));

    expect(within(screen.getByRole("dialog")).getByText("2026年")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "8月" })).toHaveFocus();
  });

  it("Escape 返回标题，点击外部关闭且不修改月份", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<><JournalMonthPicker value="2026-08" label="2026年8月" onChange={onChange} /><button>今天</button></>);
    const trigger = screen.getByRole("button", { name: "选择月份" });
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "今天" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "今天" })).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });
});
