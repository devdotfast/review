import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import whiteboardOpencodePlugin from "../../agent-plugins/opencode/index.js";
import { REVIEW_MCP_LAUNCH, WINDOWS_MCP_LAUNCH } from "./connect-prompts";
import { findReviewPackageRoot } from "./package-paths";

const repoRoot = path.resolve(
  findReviewPackageRoot(import.meta.url),
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
    command: REVIEW_MCP_LAUNCH.command,
    args: [...REVIEW_MCP_LAUNCH.args],
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

  it.skipIf(process.platform === "win32")(
    "the Codex plugin's launcher runs whiteboard mcp from the home shim",
    async () => {
      const codex = path.join(repoRoot, "packages/agent-plugins/codex");

      const manifest = z
        .object({
          mcpServers: z.object({
            whiteboard: z.object({ command: z.string(), cwd: z.string() }),
          }),
        })
        .parse(
          JSON.parse(await readFile(path.join(codex, ".mcp.json"), "utf8")),
        ).mcpServers.whiteboard;

      // Windows resolves the extensionless command to its .cmd twin.
      await readFile(path.join(codex, `${manifest.command}.cmd`));

      const home = await mkdtemp(path.join(os.tmpdir(), "codex-launch-"));

      try {
        const shim = path.join(home, ".local/bin/whiteboard");
        await mkdir(path.dirname(shim), { recursive: true });
        await writeFile(shim, '#!/bin/sh\necho "$@"\n');
        await chmod(shim, 0o755);

        const { stdout } = await promisify(execFile)(manifest.command, [], {
          cwd: path.join(codex, manifest.cwd),
          env: { ...process.env, HOME: home },
        });

        expect(stdout.trim()).toBe("mcp");
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  for (const [platform, launch] of [
    ["darwin", REVIEW_MCP_LAUNCH],
    ["win32", WINDOWS_MCP_LAUNCH],
  ] as const) {
    it(`the OpenCode plugin's config hook launches whiteboard the shared way on ${platform}`, async () => {
      const original = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: platform });

      try {
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
            command: [launch.command, ...launch.args],
            enabled: true,
          },
        });
      } finally {
        Object.defineProperty(process, "platform", original);
      }
    });
  }
});
