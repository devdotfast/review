#!/usr/bin/env node

export {};

// API version negotiation belongs to the client/host contract. Never silently
// replace the invoking CLI with a binary discovered in another Desktop build.
if (!supportedNodeRuntime()) {
  process.stderr.write(
    `Review needs Node.js 24 or newer; found ${process.versions.node}. ` +
      "Update Node, or use the review command installed by Review Desktop.\n",
  );
  process.exitCode = 1;
} else {
  const { runReviewCli } = await import("./cli-routing.js");
  process.exitCode = await runReviewCli({
    argv: process.argv.slice(2),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}

// An Electron-as-Node runtime (the app's) is trusted as-is: it is the same
// runtime the Review server runs on. Only a system Node gets the floor check,
// so an old `node` fails with an instruction instead of a syntax or
// missing-builtin crash deeper in.
function supportedNodeRuntime(): boolean {
  if (process.versions.electron) return true;
  return Number(process.versions.node.split(".")[0]) >= 24;
}
