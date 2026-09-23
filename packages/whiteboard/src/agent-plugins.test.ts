import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import whiteboardOpencodePlugin from "../../agent-plugins/opencode/index.js";
import { WHITEBOARD_MCP_LAUNCH } from "./connect-prompts";
import { findWhiteboardPackageRoot } from "./package-paths";

const repoRoot = path.resolve(
  findWhiteboardPackageRoot(import.meta.url),
  "..",
  "..",
);

const server = z.object({ command: z.string(), args: z.array(z.string()) });

type WhiteboardServerSchema = z.ZodType<z.infer<typeof server>>;

const mcpServersWhiteboard: WhiteboardServerSchema = z
  .object({ mcpServers: z.object({ whiteboard: server }) })
  .transform((manifest) => manifest.mcpServers.whiteboard);

/** Each manifest and the schema that extracts its whiteboard server. */
const MANIFESTS: Array<{ file: string; whiteboard: WhiteboardServerSchema }> = [
  {
    file: "packages/agent-plugins/claude/.mcp.json",
    whiteboard: mcpServersWhiteboard,
  },
  {
    file: "packages/agent-plugins/codex/.mcp.json",
    whiteboard: mcpServersWhiteboard,
  },
  {
    file: "packages/agent-plugins/cursor/mcp.json",
    whiteboard: mcpServersWhiteboard,
  },
];

async function expectSharedLaunch(
  file: string,
  whiteboard: WhiteboardServerSchema,
): Promise<void> {
  const parsed = whiteboard.parse(JSON.parse(await readFile(file, "utf8")));

  expect(parsed).toEqual({
    command: WHITEBOARD_MCP_LAUNCH.command,
    args: [...WHITEBOARD_MCP_LAUNCH.args],
  });
}

describe("agent plugin manifests", () => {
  for (const manifest of MANIFESTS) {
    it(`${manifest.file} launches whiteboard the shared way`, async () => {
      await expectSharedLaunch(
        path.join(repoRoot, manifest.file),
        manifest.whiteboard,
      );
    });
  }

  it("the OpenCode plugin's config hook launches whiteboard the shared way", async () => {
    const { config } = await whiteboardOpencodePlugin();

    const other = {
      type: "remote",
      url: "https://example.invalid",
    } satisfies { type: "remote"; url: string };

    const opencodeConfig = { mcp: { other } };

    await config(opencodeConfig);

    expect(opencodeConfig.mcp).toEqual({
      other,
      whiteboard: {
        type: "local",
        command: [WHITEBOARD_MCP_LAUNCH.command, ...WHITEBOARD_MCP_LAUNCH.args],
        enabled: true,
      },
    });
  });
});
