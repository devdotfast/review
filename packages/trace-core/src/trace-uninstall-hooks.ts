import {
  AGENT_TRACE_HOOK_AGENTS,
  type TraceHookOwner,
  removeAgentTraceHook,
  traceGitHookCommandOwner,
} from "./agent-trace-hooks";
import { type CliJsonOutput, emitJsonEvent, humanStream } from "./cli-output";
import { errorMessage } from "./error-message";
import type { TraceScope } from "./trace-command";
import {
  disableTraceRepository,
  listTraceRepositoryRoots,
  traceRepositoryStatus,
} from "./trace-repository-hooks";

/** Release only this CLI's hooks; keep its install, login, consent and data. */
export async function runTraceUninstallHooks(
  input: CliJsonOutput & {
    scope: TraceScope;
    cwd: string;
    owner: TraceHookOwner;
  },
): Promise<number> {
  const removed: string[] = [];
  const repositories: string[] = [];
  const errors: string[] = [];

  for (const agent of AGENT_TRACE_HOOK_AGENTS) {
    try {
      if (
        await removeAgentTraceHook(
          agent,
          input.scope.homeDir,
          input.owner,
          input.scope.env,
        )
      )
        removed.push(agent);
    } catch (error) {
      errors.push(`${agent}: ${errorMessage(error)}`);
    }
  }

  const roots = new Set([
    input.cwd,
    ...(await listTraceRepositoryRoots(input.scope.homeDir)),
  ]);

  for (const cwd of roots) {
    try {
      const status = await traceRepositoryStatus(cwd);

      if (
        !status.enabled ||
        traceGitHookCommandOwner(status.command) !== input.owner
      )
        continue;
      await disableTraceRepository({ cwd, scope: input.scope });
      repositories.push(cwd);
    } catch (error) {
      errors.push(`${cwd}: ${errorMessage(error)}`);
    }
  }

  emitJsonEvent(input, {
    event: "trace.uninstall-hooks",
    owner: input.owner,
    removed,
    repositories,
    errors,
  });
  const output = humanStream(input);
  output.write(
    `Removed ${input.owner} trace hooks. Kept the CLI, login, consent and captured traces.\n`,
  );
  output.write(
    input.owner === "review"
      ? "Desktop automatic setup will leave tracing released. Run `dev-traces install` to switch, or `review trace install` to restore Desktop tracing.\n"
      : "Run `review trace install` to switch, or `dev-traces install` to restore standalone hooks.\n",
  );

  for (const error of errors) output.write(`Could not remove hook: ${error}\n`);

  return errors.length ? 1 : 0;
}
