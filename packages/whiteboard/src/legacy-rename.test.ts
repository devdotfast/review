import { PassThrough } from "node:stream";

import type { JSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import { expect, it } from "vitest";

import {
  runLegacyWhiteboardCli,
  serveLegacyWhiteboardMcp,
} from "./legacy-rename.js";

it("rejects old CLI operations with parseable migration guidance", async () => {
  for (const argv of [
    ["api", "session_delete", "{}"],
    ["app", "launch", "--json"],
  ]) {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk;
    });
    expect(
      await runLegacyWhiteboardCli(
        argv,
        new PassThrough(),
        stdout,
        new PassThrough(),
      ),
    ).toBe(1);
    expect(JSON.parse(output)).toMatchObject({
      code: "review_renamed",
      replacement: { command: "whiteboard" },
    });
  }
});

it("answers cached MCP mutations with a protocol error and reconnect instructions", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk;
  });
  const server = await serveLegacyWhiteboardMcp(stdin, stdout);

  const request = async (
    id: number,
    method: string,
    params: JSONRPCRequest["params"],
  ) => {
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");

    const response = () =>
      output
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((reply) => reply.id === id);

    await expect.poll(response).toBeTruthy();

    return response();
  };

  try {
    await request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "stale-agent", version: "1" },
    });

    const reply = await request(2, "tools/call", {
      name: "session_delete",
      arguments: { sessionId: "saved-session" },
    });

    expect(reply.result.isError).toBe(true);
    expect(JSON.parse(reply.result.content[0].text)).toMatchObject({
      code: "review_renamed",
      replacement: { mcp: "whiteboard mcp" },
    });
    const list = await request(3, "tools/list", {});
    expect(list.result.tools).toHaveLength(1);
    expect(list.result.tools[0].name).toBe("review_migration");
  } finally {
    await server.close();
  }
});
