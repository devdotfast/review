import type { ReviewVerbRequest } from "@dev.fast/review-protocol";

import type { ReviewAgentHarness } from "../authoring-session";
import type { NativeReviewMessage } from "./native-session";

/** What a native terminal runs. The desktop pairs it with the session. */
export type NativeTerminalCommand = Extract<
  ReviewVerbRequest,
  { name: "openNativeAgentTerminal" }
>["args"]["command"];

/** Which native session a terminal should land in. Absent means a fresh one. */
export type LaunchSession = { resume: string } | { forkOf: string };

export interface TerminalCommandInput {
  session?: LaunchSession;
  /** The session the terminal will run. Reserved by `reserveSessionId`. */
  sessionId: string;
  /** Submitted when the terminal starts. Absent opens the session silently. */
  prompt?: string;
  cwd: string;
  /** Environment shared by every harness (hook endpoint, review home, PATH). */
  env: Record<string, string>;
  runtimeDirectory: string;
}

/** The per-harness half of launching a native terminal. */
export interface HarnessDialect {
  readonly harness: ReviewAgentHarness;
  /** Decide the session id before the terminal opens so Review can observe it. */
  reserveSessionId(input: {
    session?: LaunchSession;
    cwd: string;
  }): Promise<string>;
  terminalCommand(input: TerminalCommandInput): Promise<NativeTerminalCommand>;
  /** Project the native transcript into Review-visible messages. */
  readMessages(input: {
    sessionId: string;
    transcriptPath?: string;
  }): Promise<NativeReviewMessage[]>;
}
