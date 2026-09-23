import { describe, expect, it } from "vitest";

import { slugify, uniqueId } from "./slug";

describe("slugify", () => {
  it("lowercases, collapses runs of punctuation and trims dashes", () => {
    expect(slugify("  Sign-in  flow!! ")).toBe("sign-in-flow");
    expect(slugify("Order database")).toBe("order-database");
  });

  it("keeps apostrophes as separators so diagram ids stay unchanged", () => {
    expect(slugify("It's ready")).toBe("it-s-ready");
  });

  it("returns an empty string when nothing survives", () => {
    expect(slugify("☕ — !")).toBe("");
  });
});

describe("uniqueId", () => {
  it("returns the base when free and numbers from 2 otherwise", () => {
    expect(uniqueId("shared", new Set())).toBe("shared");
    expect(uniqueId("shared", new Set(["shared"]))).toBe("shared-2");
    expect(uniqueId("shared", new Set(["shared", "shared-2"]))).toBe(
      "shared-3",
    );
  });

  it("does not mutate the reserved set", () => {
    const used = new Set(["a"]);
    uniqueId("a", used);
    expect([...used]).toEqual(["a"]);
  });
});
