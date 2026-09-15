import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  agentTraceHomeDirectory,
  agentTraceHookPath,
  describeTraceHookOwners,
  installClaudeTraceHook,
  installCodexTraceHook,
  installOpenCodeTraceExtension,
  installPiTraceExtension,
  removeAgentTraceHook,
  traceHookCommandOwner,
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

    const second = await installPiTraceExtension(homeDir);
    expect(second.modified).toBe(false);
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

describe("the OpenCode configuration base", () => {
  it("writes the plugin under XDG_CONFIG_HOME and looks for it there", async () => {
    const homeDir = await makeTempHome();
    const xdg = path.join(homeDir, "xdg");
    const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: xdg };

    const result = await installOpenCodeTraceExtension(
      homeDir,
      "dev-traces",
      env,
    );

    const expected = path.join(xdg, "opencode", "plugins", "review-trace.ts");
    expect(result.path).toBe(expected);
    expect(existsSync(expected)).toBe(true);
    expect(
      existsSync(path.join(homeDir, ".config", "opencode", "plugins")),
    ).toBe(false);
    // The presence check and the hook path read the same base.
    expect(agentTraceHomeDirectory("opencode", homeDir, env)).toBe(
      path.join(xdg, "opencode"),
    );
    expect(agentTraceHookPath("opencode", homeDir, env)).toBe(expected);
    expect((await describeTraceHookOwners(homeDir, env)).opencode).toBe(
      "dev-traces",
    );
    expect(
      await removeAgentTraceHook("opencode", homeDir, "dev-traces", env),
    ).toBe(true);
    expect(existsSync(expected)).toBe(false);
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is not set", async () => {
    const homeDir = await makeTempHome();
    const result = await installOpenCodeTraceExtension(homeDir, "review", {});

    expect(result.path).toBe(
      path.join(homeDir, ".config", "opencode", "plugins", "review-trace.ts"),
    );
    expect(agentTraceHomeDirectory("opencode", homeDir, {})).toBe(
      path.join(homeDir, ".config", "opencode"),
    );
  });
});

describe("hook ownership", () => {
  it("recognizes only single executable commands, including shell-quoted paths", () => {
    for (const command of [
      "review",
      "/opt/review",
      "'/space here/review'",
      "'/it'\"'\"'s here/review'",
    ]) {
      expect(traceHookCommandOwner(`${command} trace hook SessionStart`)).toBe(
        "review",
      );
    }

    expect(traceHookCommandOwner("dev-traces trace hook SessionEnd")).toBe(
      "dev-traces",
    );

    for (const command of [
      "echo x; /opt/review",
      "env /opt/review",
      "$(echo /opt/review)",
      "'x'; '/opt/review'",
      "other",
      "review trace sync",
    ]) {
      expect(
        traceHookCommandOwner(`${command} trace hook SessionStart`),
      ).toBeNull();
    }
  });

  it("replaces owned commands in place and removes only the selected owner", async () => {
    const home = await makeTempHome();
    expect(await describeTraceHookOwners(home)).toEqual({
      claude: null,
      codex: null,
      pi: null,
      opencode: null,
    });

    for (const install of [
      installClaudeTraceHook,
      installCodexTraceHook,
      installPiTraceExtension,
      installOpenCodeTraceExtension,
    ]) {
      await install(home);
      const shim = "/it's a path/dev-traces";
      const result = await install(home, shim);
      expect(result.modified).toBe(true);
      expect((await install(home, shim)).modified).toBe(false);
      expect(await removeAgentTraceHook(result.agent, home)).toBe(false);
    }

    expect(await describeTraceHookOwners(home)).toEqual({
      claude: "dev-traces",
      codex: "dev-traces",
      pi: "dev-traces",
      opencode: "dev-traces",
    });

    const claude = JSON.parse(
      await readFile(path.join(home, ".claude/settings.json"), "utf8"),
    );

    expect(claude.hooks.SessionStart).toHaveLength(1);
    const codex = await readFile(path.join(home, ".codex/config.toml"), "utf8");
    expect(codex.match(/\[\[hooks.SessionStart\]\]/g)).toHaveLength(1);

    for (const agent of ["claude", "codex", "pi", "opencode"] as const) {
      expect(await removeAgentTraceHook(agent, home, "dev-traces")).toBe(true);
    }

    expect(await readFile(path.join(home, ".codex/config.toml"), "utf8")).toBe(
      "",
    );
    expect(await describeTraceHookOwners(home)).toEqual({
      claude: null,
      codex: null,
      pi: null,
      opencode: null,
    });
  });

  it("switches both CLI owners back to Review without duplicate lifecycle entries", async () => {
    const home = await makeTempHome();

    for (const install of [installClaudeTraceHook, installCodexTraceHook]) {
      await install(home, "dev-traces");
      expect((await install(home)).modified).toBe(true);
      expect((await install(home)).modified).toBe(false);
    }

    expect(await describeTraceHookOwners(home)).toEqual({
      claude: "review",
      codex: "review",
      opencode: null,
      pi: null,
    });
  });

  it("preserves foreign Claude hooks and their group metadata", async () => {
    const home = await makeTempHome();
    const result = await installClaudeTraceHook(home);
    const config = JSON.parse(await readFile(result.path, "utf8"));

    const foreign = {
      type: "command",
      command: "echo x; /opt/review trace hook SessionStart",
    };

    config.hooks.SessionStart[0].hooks.push(foreign);
    config.hooks.SessionStart[0].matcher = "keep";
    await writeFile(result.path, JSON.stringify(config));
    await installClaudeTraceHook(home, "dev-traces");
    await removeAgentTraceHook("claude", home, "dev-traces");
    const remaining = JSON.parse(await readFile(result.path, "utf8"));
    expect(remaining.hooks.SessionStart).toEqual([
      { matcher: "keep", hooks: [foreign] },
    ]);
  });

  it("leaves noncanonical Codex groups intact when they have foreign children or extra keys", async () => {
    const home = await makeTempHome();
    await mkdir(path.join(home, ".codex"));
    const file = path.join(home, ".codex/config.toml");

    for (const extra of [
      '[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "foreign trace hook SessionStart"\n',
      "timeout = 30\n",
      '[other]\nkeep = true\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "foreign trace hook SessionStart"\n',
    ]) {
      const original = `[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "review trace hook SessionStart"\n${extra}`;
      await writeFile(file, original);
      expect(await removeAgentTraceHook("codex", home)).toBe(false);
      expect(await readFile(file, "utf8")).toBe(original);
      await installCodexTraceHook(home, "dev-traces");
      expect(await removeAgentTraceHook("codex", home, "dev-traces")).toBe(
        true,
      );
      expect(await readFile(file, "utf8")).toBe(original);
    }
  });

  it("preserves foreign Codex hooks and unrelated command lines across ownership changes", async () => {
    const home = await makeTempHome();
    await mkdir(path.join(home, ".codex"));

    const foreign = `# keep me
[[hooks.SessionStart]]
[[hooks.SessionStart.hooks]]
type = "command"
command = "foreign trace hook SessionStart"

[other]
command = "review trace hook SessionStart"
`;

    const file = path.join(home, ".codex/config.toml");
    await writeFile(file, foreign);
    await installCodexTraceHook(home);
    expect((await describeTraceHookOwners(home)).codex).toBe("review");
    await installCodexTraceHook(home, "/it's a path/dev-traces");
    expect(await readFile(file, "utf8")).toContain(foreign.trimEnd());
    expect(await removeAgentTraceHook("codex", home)).toBe(false);
    expect(await removeAgentTraceHook("codex", home, "dev-traces")).toBe(true);
    expect((await readFile(file, "utf8")).trimEnd()).toBe(foreign.trimEnd());
  });

  for (const install of [
    installPiTraceExtension,
    installOpenCodeTraceExtension,
  ]) {
    for (const failure of ["missing", "closed"]) {
      it(`keeps ${install.name} harness alive when child is ${failure}`, async () => {
        const home = await makeTempHome();
        const command = path.join(home, "child");

        if (failure === "closed")
          await writeFile(command, "#!/bin/sh\nexec 0<&-\nexit 0\n", {
            mode: 0o700,
          });
        const result = await install(home, command);

        const runner = `import plugin from ${JSON.stringify(pathToFileURL(result.path).href)};
          const session = "s".repeat(2 * 1024 * 1024);
          if (${JSON.stringify(result.agent)} === "pi") {
            const callbacks = [];
            plugin({on: (_name, callback) => callbacks.push(callback)});
            for (const callback of callbacks) await callback({}, {cwd:${JSON.stringify(home)},sessionManager:{getSessionId:()=>session}});
          } else {
            const hooks = await plugin({directory:${JSON.stringify(home)}});
            for (const event of [{type:"session.created",properties:{info:{id:session}}}, {type:"message.updated",properties:{info:{role:"user",sessionID:session}}}, {type:"session.idle",properties:{sessionID:session}}]) await hooks.event({event});
          }
          console.log("harness survived");`;

        const child = spawnSync(
          process.execPath,
          ["--input-type=module", "-e", runner],
          { encoding: "utf8", timeout: 10000 },
        );

        expect(child.stderr).toBe("");
        expect(child.status).toBe(0);
        expect(child.stdout).toBe("harness survived\n");
      });
    }
  }
});

describe("hook coexistence", () => {
  const installers = [
    installClaudeTraceHook,
    installCodexTraceHook,
    installPiTraceExtension,
    installOpenCodeTraceExtension,
  ];

  it("keeps the other CLI's hook while its command file exists", async () => {
    const home = await makeTempHome();
    const reviewShim = path.join(home, ".local", "bin", "review");
    const tracesShim = path.join(home, ".local", "bin", "dev-traces");
    await mkdir(path.dirname(reviewShim), { recursive: true });
    await writeFile(reviewShim, "#!/bin/sh\n");

    for (const install of installers) {
      await install(home, reviewShim);
      expect(await install(home, tracesShim)).toMatchObject({
        modified: false,
        kept: "review",
      });
      // The owner still rewrites its own hook.
      expect((await install(home, reviewShim)).modified).toBe(false);
    }

    expect(await describeTraceHookOwners(home)).toEqual({
      claude: "review",
      codex: "review",
      pi: "review",
      opencode: "review",
    });

    // A hook whose command file is gone is replaced.
    await rm(reviewShim);

    for (const install of installers) {
      const replaced = await install(home, tracesShim);
      expect(replaced.modified).toBe(true);
      expect(replaced.kept).toBeUndefined();
    }

    expect(await describeTraceHookOwners(home)).toEqual({
      claude: "dev-traces",
      codex: "dev-traces",
      pi: "dev-traces",
      opencode: "dev-traces",
    });
  });
});
