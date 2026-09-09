import { describe, expect, it } from "vitest";

import { isAuthoringInput, isDerivedReviewPath } from "./review-derived-paths";

describe("isAuthoringInput", () => {
  it("excludes the managed artifacts directory", () => {
    expect(isAuthoringInput("artifacts")).toBe(false);
  });

  it("still excludes derived state and other managed names", () => {
    expect(isAuthoringInput(".build")).toBe(false);
    expect(isAuthoringInput("review.json")).toBe(false);
    expect(isAuthoringInput(".bundle")).toBe(false);
  });

  it("includes ordinary authored files", () => {
    expect(isAuthoringInput("review.mdx")).toBe(true);
  });
});

describe("isDerivedReviewPath", () => {
  it("does not treat artifacts as derived (it is managed, not regenerable)", () => {
    expect(isDerivedReviewPath("artifacts")).toBe(false);
  });
});
