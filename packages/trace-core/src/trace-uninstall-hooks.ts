import {
  AGENT_TRACE_HOOK_AGENTS,
  removeAgentTraceHook,
} from "./agent-trace-hooks";
import { type CliJsonOutput, emitJsonEvent, humanStream } from "./cli-output";
import type { TraceScope } from "./trace-command";
import { disableAllTraceRepositories } from "./trace-repository-hooks";

/** Release Review hooks; keep its install, login, consent and data. */
export async function runTraceUninstallHooks(
  input: CliJsonOutput & {
    scope: TraceScope;
  },
): Promise<number> {
  const removed: string[] = [];

  for (const agent of AGENT_TRACE_HOOK_AGENTS) {
    if (await removeAgentTraceHook(agent, input.scope.homeDir, input.scope.env))
      removed.push(agent);
  }

  const { disabled } = await disableAllTraceRepositories(input.scope);

  emitJsonEvent(input, {
    event: "trace.uninstall-hooks",
    owner: "review",
    removed,
    repositories: disabled,
  });
  const output = humanStream(input);
  output.write(
    `Removed whiteboard trace hooks. Kept the CLI, login, consent and captured traces.\n`,
  );
  output.write("Run `whiteboard trace install` to restore trace hooks.\n");

  return 0;
}
