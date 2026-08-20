// @vitest-environment node

import { describe, expect, it } from "vitest";
import config from "../vite.config";

describe("Vite environment", () => {
  it("loads frontend variables from the project root", () => {
    expect(config).toMatchObject({ envDir: "../.." });
  });
});
