// Managed by Review Desktop (@dev.fast/review).

export default async function reviewPlugin() {
  return {
    "shell.env": async (
      input: { sessionID?: string },
      output: { env: Record<string, string> },
    ) => {
      if (input.sessionID) {
        output.env.DEV_FAST_AGENT_SESSION = `opencode:${input.sessionID}`;
      }
    },
  };
}
