import {
  AGENT_TRACE_HOOK_AGENTS,
  type TraceHookOwner,
  removeAgentTraceHook,
} from "./agent-trace-hooks";
import { type CliJsonOutput, emitJsonEvent, humanStream } from "./cli-output";
import type { TraceScope } from "./trace-command";
import { disableAllTraceRepositories } from "./trace-repository-hooks";

/** Release only this CLI's hooks; keep its install, login, consent and data. */
export async function runTraceUninstallHooks(
  input: CliJsonOutput & {
    scope: TraceScope;
    owner: TraceHookOwner;
  },
): Promise<number> {
  const removed: string[] = [];

  for (const agent of AGENT_TRACE_HOOK_AGENTS) {
    if (
      await removeAgentTraceHook(
        agent,
        input.scope.homeDir,
        input.owner,
        input.scope.env,
      )
    )
      removed.push(agent);
  }

  const { disabled } = await disableAllTraceRepositories(input.scope, {
    owner: input.owner,
  });

  emitJsonEvent(input, {
    event: "trace.uninstall-hooks",
    owner: input.owner,
    removed,
    repositories: disabled,
  });
  const output = humanStream(input);
  output.write(
    `Removed ${input.owner} trace hooks. Kept the CLI, login, consent and captured traces.\n`,
  );
  output.write(
    input.owner === "review"
      ? "Run `dev-traces install` to switch, or `review trace install` to restore Desktop tracing.\n"
      : "Run `review trace install` to switch, or `dev-traces install` to restore standalone hooks.\n",
  );

  return 0;
}
