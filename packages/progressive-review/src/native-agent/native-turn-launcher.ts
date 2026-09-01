import { DEV_REVIEW_HOME_ENV, devReviewHome } from "../review-storage";
import * as claudeCode from "./claude-code";
import * as codex from "./codex";
import type {
  HarnessDialect,
  LaunchSession,
  NativeTerminalInput,
} from "./harness";
import { NativeSessionObserverRegistry } from "./native-observer";
import type { ReviewTurnRoute } from "./native-session";
import type {
  LaunchReviewTurnInput,
  NativeTerminalHandle,
  ObservedNativeSession,
  ReviewAgentHarness,
  SessionRef,
} from "./native-session";
import * as pi from "./pi";
import {
  REVIEW_AGENT_HOOK_TOKEN_ENV,
  REVIEW_AGENT_HOOK_URL_ENV,
  REVIEW_AGENT_THREAD_URL_ENV,
  ReviewCommandPath,
} from "./terminal-command";

export interface NativeReviewTurnLauncherInput {
  hookBaseUrl: string;
  hookToken: string;
  runtimeDirectory: string;
  reviewCliPath?: string;
  reviewCliRuntimePath?: string;
  openTerminal(input: NativeTerminalInput): Promise<void>;
  observer?: NativeSessionObserverRegistry;
  codex?: codex.CodexDialectDependencies;
}

export interface OpenNativeReviewSessionInput {
  launchId: string;
  cwd: string;
  binding: SessionRef;
}

/** Launches Review questions in normal native agent terminals. */
export class NativeReviewTurnLauncher {
  readonly #hookBaseUrl: string;
  readonly #hookToken: string;
  readonly #runtimeDirectory: string;
  readonly #commandPath: ReviewCommandPath;
  readonly #openTerminal: NativeReviewTurnLauncherInput["openTerminal"];
  readonly #dialects: Record<ReviewAgentHarness, HarnessDialect>;
  readonly observer: NativeSessionObserverRegistry;

  constructor(input: NativeReviewTurnLauncherInput) {
    this.#hookBaseUrl = input.hookBaseUrl.replace(/\/$/u, "");
    this.#hookToken = input.hookToken;
    this.#runtimeDirectory = input.runtimeDirectory;
    this.#commandPath = new ReviewCommandPath(input);
    this.#openTerminal = input.openTerminal;
    this.#dialects = {
      "claude-code": claudeCode.dialect,
      codex: codex.createDialect(input.codex),
      pi: pi.dialect,
    };
    this.observer = input.observer ?? new NativeSessionObserverRegistry();
  }

  async launchTurn(
    input: LaunchReviewTurnInput,
  ): Promise<NativeTerminalHandle> {
    const harness =
      input.route.kind === "fork"
        ? input.route.source.harness
        : input.route.kind === "resume"
          ? input.route.session.harness
          : input.route.harness;
    const requestedSessionId = await this.#requestedSessionId(input, harness);
    const ref = { harness, sessionId: requestedSessionId };
    const handle = this.observer.beginLaunch(ref);
    try {
      const terminal = await this.#terminalInput(
        input,
        harness,
        requestedSessionId,
      );
      await this.#openTerminal(terminal);
      return handle;
    } catch (error) {
      this.observer.observerFailed(ref, error);
      await handle.detach();
      throw error;
    }
  }

  observe(binding: SessionRef): ObservedNativeSession {
    return this.observer.observe(binding);
  }

  async openSession(
    input: OpenNativeReviewSessionInput,
  ): Promise<NativeTerminalHandle> {
    const handle = this.observer.beginLaunch(input.binding);
    try {
      await this.#openTerminal(
        await this.#terminalInput(
          {
            launchId: input.launchId,
            threadId: "",
            reviewMessageId: "",
            cwd: input.cwd,
            prompt: "",
            route: { kind: "resume", session: input.binding },
          },
          input.binding.harness,
          input.binding.sessionId,
          false,
        ),
      );
      return handle;
    } catch (error) {
      this.observer.observerFailed(input.binding, error);
      await handle.detach();
      throw error;
    }
  }

  async #requestedSessionId(
    input: LaunchReviewTurnInput,
    harness: ReviewAgentHarness,
  ): Promise<string> {
    return this.#dialects[harness].reserveSessionId({
      session: launchSession(input.route),
      cwd: input.cwd,
    });
  }

  async #terminalInput(
    input: LaunchReviewTurnInput,
    harness: ReviewAgentHarness,
    requestedSessionId: string,
    submitPrompt = true,
  ): Promise<NativeTerminalInput> {
    const hookUrl = `${this.#hookBaseUrl}/${harness}/${encodeURIComponent(requestedSessionId)}`;
    const pathValue = await this.#commandPath.resolve();
    return this.#dialects[harness].terminalCommand({
      launchId: input.launchId,
      session: launchSession(input.route),
      sessionId: requestedSessionId,
      ...(submitPrompt ? { prompt: input.prompt } : {}),
      cwd: input.cwd,
      env: {
        [REVIEW_AGENT_HOOK_URL_ENV]: hookUrl,
        [REVIEW_AGENT_HOOK_TOKEN_ENV]: this.#hookToken,
        [REVIEW_AGENT_THREAD_URL_ENV]: `${hookUrl}/thread`,
        [DEV_REVIEW_HOME_ENV]: devReviewHome(),
        ...(pathValue ? { PATH: pathValue } : {}),
      },
      runtimeDirectory: this.#runtimeDirectory,
    });
  }
}

function launchSession(route: ReviewTurnRoute): LaunchSession | undefined {
  switch (route.kind) {
    case "fork":
      return { forkOf: route.source.sessionId };
    case "resume":
      return { resume: route.session.sessionId };
    case "new":
      return undefined;
  }
}
