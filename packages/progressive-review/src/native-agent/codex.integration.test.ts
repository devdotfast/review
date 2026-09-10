import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { jsonObject, jsonString } from "@dev.fast/review-protocol";
import { expect, it, vi } from "vitest";

import { server } from "./codex";
import { CodexAppServerClient } from "./codex-app-server";

// Run against the installed Codex with REVIEW_CODEX_INTEGRATION=1. An isolated
// home keeps this independent of user profiles, credentials, and saved threads.
it.runIf(process.env.REVIEW_CODEX_INTEGRATION === "1")(
  "accepts a terminal follow-up selecting the Ask permission profile",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "review-codex-live-"));
    vi.stubEnv("CODEX_HOME", directory);
    const agent = server({
      runtimeDirectory: directory,
      desktopEndpoint: { baseUrl: "http://127.0.0.1:4000", token: "test" },
    });
    let terminal: CodexAppServerClient | undefined;
    try {
      const launch = await agent.launch({ cwd: directory });
      const remoteIndex = launch.command.args.indexOf("--remote");
      terminal = await CodexAppServerClient.connectWebSocket(
        launch.command.args[remoteIndex + 1]!,
      );
      // Unlike Review's initial submission, the TUI explicitly re-selects the
      // active profile. This causes Codex to reload the server configuration.
      const result = await terminal.request("turn/start", {
        threadId: launch.sessionId,
        permissions: "review-ask",
        input: [],
      });
      const turn = jsonObject(jsonObject(result)?.turn);
      expect(jsonString(turn?.id)).toBeTruthy();
      expect(turn?.error).toBeNull();
    } finally {
      await terminal?.close();
      await agent.close();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
