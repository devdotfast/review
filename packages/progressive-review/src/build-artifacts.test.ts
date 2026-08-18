import { describe, expect, it } from "vitest";

import tsdownConfig from "../tsdown.config";

describe("progressive-review build artifacts", () => {
  it("does not bundle the retired compiler extraction worker", () => {
    const config = Array.isArray(tsdownConfig) ? tsdownConfig[0] : tsdownConfig;

    expect(config).toBeTruthy();
    expect(config?.entry?.["extract-worker"]).toBeUndefined();
    expect(config?.copy).toBeUndefined();
  });
});
