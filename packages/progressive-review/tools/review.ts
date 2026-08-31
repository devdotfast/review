import { tool } from "@opencode-ai/plugin";

// Managed by Review Desktop (@dev.fast/review).

export default tool({
  description:
    "Create or update a Review while preserving the exact OpenCode source session.",
  args: {
    base: tool.schema.string().optional(),
    head: tool.schema.string().optional(),
    pullRequest: tool.schema.string().optional(),
    update: tool.schema.boolean().optional(),
    review: tool.schema.string().optional(),
    newReview: tool.schema.boolean().optional(),
  },
  async execute(args, context) {
    const command = [
      "review",
      "scaffold",
      "--json",
      ...(args.base ? ["--base", args.base] : []),
      ...(args.head ? ["--head", args.head] : []),
      ...(args.pullRequest ? ["--pr", args.pullRequest] : []),
      ...(args.update ? ["--update"] : []),
      ...(args.review ? ["--review", args.review] : []),
      ...(args.newReview ? ["--new"] : []),
      "--opencode-session-id",
      context.sessionID,
      "--opencode-message-id",
      context.messageID,
      "--opencode-directory",
      context.directory,
      "--opencode-worktree",
      context.worktree,
    ];
    const child = Bun.spawn(command, {
      cwd: context.directory,
      env: { ...process.env, INIT_CWD: context.directory },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(stderr.trim() || stdout.trim());
    return stdout.trim();
  },
});
