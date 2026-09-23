import { describe, expect, it } from "vitest";

import { WHITEBOARD_MCP_LAUNCH } from "./connect-prompts";
import { cursorInstallDeeplink } from "./cursor-deeplink";

describe("cursorInstallDeeplink", () => {
  it("encodes the bare server config", () => {
    const link = cursorInstallDeeplink({
      command: WHITEBOARD_MCP_LAUNCH.command,
      args: [...WHITEBOARD_MCP_LAUNCH.args],
    });

    const url = new URL(link);

    expect(url.protocol).toBe("cursor:");

    expect(url.searchParams.get("name")).toBe("whiteboard");

    const config = url.searchParams.get("config") ?? "";

    expect(JSON.parse(Buffer.from(config, "base64").toString("utf8"))).toEqual({
      command: "sh",
      args: ["-c", 'exec "$HOME/.local/bin/whiteboard" mcp'],
    });
  });
});
