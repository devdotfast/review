import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  installClaudeTraceHook,
  installCodexTraceHook,
  installOpenCodeTraceExtension,
  installPiTraceExtension,
  removeAgentTraceHook,
} from "./agent-trace-hooks";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-trace-hooks-test-"));
  tempRoots.push(dir);
  return dir;
}

describe("agent-trace-hooks", () => {
  it("installs Claude Code trace hooks in ~/.claude/settings.json idempotently", async () => {
    const homeDir = await makeTempHome();

    const first = await installClaudeTraceHook(homeDir);
    expect(first.modified).toBe(true);
    expect(existsSync(first.path)).toBe(true);

    const content = JSON.parse(await readFile(first.path, "utf8"));
    expect(content.hooks.SessionStart[0].hooks[0].command).toBe(
      "review trace hook SessionStart",
    );
    expect(content.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      "review trace hook UserPromptSubmit",
    );
    expect(content.hooks.SessionEnd[0].hooks[0].command).toBe(
      "review trace hook SessionEnd",
    );

    const second = await installClaudeTraceHook(homeDir);
    expect(second.modified).toBe(false);

    // Verify existing custom settings are preserved
    await writeFile(
      first.path,
      JSON.stringify(
        { customKey: "customValue", hooks: content.hooks },
        null,
        2,
      ),
      "utf8",
    );
    const third = await installClaudeTraceHook(homeDir);
    expect(third.modified).toBe(false);
    const preserved = JSON.parse(await readFile(first.path, "utf8"));
    expect(preserved.customKey).toBe("customValue");
  });

  it("installs Codex trace hooks in ~/.codex/config.toml idempotently", async () => {
    const homeDir = await makeTempHome();

    const first = await installCodexTraceHook(homeDir);
    expect(first.modified).toBe(true);
    expect(existsSync(first.path)).toBe(true);

    const content = await readFile(first.path, "utf8");
    expect(content).toContain("[[hooks.SessionStart]]");
    expect(content).toContain("review trace hook SessionStart");
    expect(content).toContain("[[hooks.UserPromptSubmit]]");
    expect(content).toContain("review trace hook UserPromptSubmit");
    expect(content).toContain("[[hooks.SessionEnd]]");
    expect(content).toContain("review trace hook SessionEnd");

    const second = await installCodexTraceHook(homeDir);
    expect(second.modified).toBe(false);
  });

  it("adds the Codex heartbeat to an existing lifecycle-only setup", async () => {
    const homeDir = await makeTempHome();
    const codexDir = path.join(homeDir, ".codex");
    const configPath = path.join(codexDir, "config.toml");
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      configPath,
      `model = "gpt-5"

[[hooks.SessionStart]]
[[hooks.SessionStart.hooks]]
type = "command"
command = "review trace hook SessionStart"
statusMessage = "Recording agent session id for trace stamping"

[hooks.state]
keep = "yes"

[[hooks.SessionEnd]]
[[hooks.SessionEnd.hooks]]
type = "command"
command = "review trace hook SessionEnd"
`,
    );

    expect((await installCodexTraceHook(homeDir)).modified).toBe(true);
    const installed = await readFile(configPath, "utf8");
    expect(installed).toContain("review trace hook UserPromptSubmit");
    expect(installed.match(/review trace hook SessionStart/g)).toHaveLength(1);
    expect(installed.match(/review trace hook SessionEnd/g)).toHaveLength(1);
    expect((await installCodexTraceHook(homeDir)).modified).toBe(false);

    expect(await removeAgentTraceHook("codex", homeDir)).toBe(true);
    const removed = await readFile(configPath, "utf8");
    expect(removed).toContain('model = "gpt-5"');
    expect(removed).toContain('keep = "yes"');
    expect(removed).not.toContain("review trace hook");
  });

  it("installs Pi trace extension in ~/.pi/agent/extensions/review-trace.ts idempotently", async () => {
    const homeDir = await makeTempHome();

    const first = await installPiTraceExtension(homeDir);
    expect(first.modified).toBe(true);
    expect(existsSync(first.path)).toBe(true);

    const content = await readFile(first.path, "utf8");
    expect(content).toContain("session_start");
    expect(content).toContain('pi.on("turn_start"');
    expect(content).toContain('runTraceHook("TurnStart"');
    expect(content).toContain("session_shutdown");
    expect(content).toContain("review");

    const second = await installPiTraceExtension(homeDir);
    expect(second.modified).toBe(false);
  });

  it("installs the OpenCode trace plugin in ~/.config/opencode/plugins/review-trace.ts idempotently", async () => {
    const homeDir = await makeTempHome();

    const first = await installOpenCodeTraceExtension(homeDir, "/opt/review");
    expect(first.modified).toBe(true);
    expect(first.path).toBe(
      path.join(homeDir, ".config", "opencode", "plugins", "review-trace.ts"),
    );

    const second = await installOpenCodeTraceExtension(homeDir, "/opt/review");
    expect(second.modified).toBe(false);

    expect(await removeAgentTraceHook("opencode", homeDir)).toBe(true);
    expect(existsSync(first.path)).toBe(false);
    expect(await removeAgentTraceHook("opencode", homeDir)).toBe(false);
  });

  it("leaves an OpenCode trace plugin it did not write alone", async () => {
    const homeDir = await makeTempHome();
    const pluginPath = path.join(
      homeDir,
      ".config",
      "opencode",
      "plugins",
      "review-trace.ts",
    );
    await mkdir(path.dirname(pluginPath), { recursive: true });
    await writeFile(pluginPath, "export default async () => ({});\n");

    expect(await removeAgentTraceHook("opencode", homeDir)).toBe(false);
    expect(existsSync(pluginPath)).toBe(true);
  });

  it("removes owned hooks and preserves unrelated agent configuration", async () => {
    const homeDir = await makeTempHome();
    const claude = await installClaudeTraceHook(homeDir);
    const codex = await installCodexTraceHook(homeDir);
    const pi = await installPiTraceExtension(homeDir);
    const claudeConfig = JSON.parse(await readFile(claude.path, "utf8"));
    claudeConfig.customKey = "keep";
    await writeFile(claude.path, JSON.stringify(claudeConfig, null, 2));
    await writeFile(
      codex.path,
      `model = "gpt-5"\n${await readFile(codex.path, "utf8")}`,
    );

    expect(await removeAgentTraceHook("claude", homeDir)).toBe(true);
    expect(await removeAgentTraceHook("codex", homeDir)).toBe(true);
    expect(await removeAgentTraceHook("pi", homeDir)).toBe(true);

    expect(await readFile(claude.path, "utf8")).toContain(
      '"customKey": "keep"',
    );
    expect(await readFile(claude.path, "utf8")).not.toContain(
      "review trace hook",
    );
    expect(await readFile(codex.path, "utf8")).toBe('model = "gpt-5"\n');
    expect(existsSync(pi.path)).toBe(false);
  });
});
