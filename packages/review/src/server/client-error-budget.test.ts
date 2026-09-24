import { describe, expect, it } from "vitest";

import {
  CLIENT_ERROR_BUDGET_PER_HASH,
  ClientErrorBudget,
} from "./client-error-budget";

describe("ClientErrorBudget", () => {
  it("sends the first five, bursts on the sixth, then bursts every hundredth", () => {
    const budget = new ClientErrorBudget();

    const verdicts = Array.from(
      { length: 206 },
      () => budget.admit("s1", "aaaa").verdict,
    );

    expect(verdicts.slice(0, CLIENT_ERROR_BUDGET_PER_HASH)).toEqual([
      "send",
      "send",
      "send",
      "send",
      "send",
    ]);
    expect(verdicts[5]).toBe("burst");
    expect(verdicts.slice(6, 104).every((verdict) => verdict === "drop")).toBe(
      true,
    );
    expect(verdicts[104]).toBe("burst");
    expect(budget.admit("s1", "aaaa").suppressed).toBe(202);
  });

  it("admits a different fingerprint while one is exhausted", () => {
    const budget = new ClientErrorBudget();

    for (let i = 0; i < 10; i++) budget.admit("s1", "aaaa");
    expect(budget.admit("s1", "bbbb").verdict).toBe("send");
    expect(budget.admit("s2", "aaaa").verdict).toBe("send");
  });

  it("forgets the oldest keys past its capacity", () => {
    const budget = new ClientErrorBudget(2);
    budget.admit("s1", "aaaa");
    budget.admit("s1", "bbbb");
    budget.admit("s1", "cccc");
    expect(budget.admit("s1", "aaaa").suppressed).toBe(0);
  });
});
