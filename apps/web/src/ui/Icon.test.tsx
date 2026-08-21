import { render } from "@testing-library/react";
import { Plus } from "lucide-react";
import { expect, it } from "vitest";
import { Icon } from "./Icon";

it("renders a lucide svg and hides it from the name when labelled by text", () => {
  const { container } = render(<button type="button">加入<Icon icon={Plus} /></button>);
  expect(container.querySelector("svg")).not.toBeNull();
  expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
});
