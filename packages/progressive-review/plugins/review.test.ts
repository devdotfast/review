import { describe, expect, it } from "vitest";

import reviewPlugin from "./review";

describe("OpenCode Review plugin", () => {
  it("exposes the active session to shell commands", async () => {
    const hooks = await reviewPlugin();
    const output = { env: {} as Record<string, string> };

    await hooks["shell.env"]({ sessionID: "session-1" }, output);

    expect(output.env).toEqual({
      DEV_FAST_AGENT_SESSION: "opencode:session-1",
    });
  });
});
