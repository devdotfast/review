import { randomUUID } from "node:crypto";

import type { HarnessDialect, NativeTerminalInput } from "./harness";
import { HookObservedAgentServer } from "./hook-observed-server";
import type { AgentServer, AgentServerOptions } from "./native-session";
import { readPiReviewMessages } from "./pi-transcript";
import { companionModulePath } from "./terminal-command";

export const dialect: HarnessDialect = {
  harness: "pi",

  // Pi accepts a caller-chosen id (`--session-id`), so reserving one is just
  // minting it. The session exists once the terminal starts.
  async reserveSessionId(input) {
    if (input.session && "resume" in input.session) {
      return input.session.resume;
    }
    return randomUUID();
  },

  async terminalCommand(input) {
    const args = [
      "-e",
      companionModulePath("pi-observer-extension"),
      "--tools",
      "bash,find,grep,ls,read",
    ];
    if (input.session && "forkOf" in input.session) {
      args.push(
        "--fork",
        input.session.forkOf,
        "--session-id",
        input.sessionId,
      );
    } else if (input.session) {
      args.push("--session", input.session.resume);
    } else {
      args.push("--session-id", input.sessionId);
    }
    if (input.prompt !== undefined) args.push(input.prompt);
    return {
      launchId: input.launchId,
      harness: "pi",
      cwd: input.cwd,
      executable: "pi",
      args,
      env: input.env,
    } satisfies NativeTerminalInput;
  },

  readMessages: readPiReviewMessages,
};

export function server(options: AgentServerOptions): AgentServer {
  return new HookObservedAgentServer(dialect, options);
}
