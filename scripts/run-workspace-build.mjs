import { spawnSync } from "node:child_process";

const [command, ...args] = process.argv.slice(2);

if (!command) {
  throw new Error("usage: run-workspace-build.mjs <command> [...args]");
}

if (process.env.DEVFAST_REUSE_WORKSPACE_BUILDS === "1") {
  console.log(
    "Reusing workspace builds produced by the repository Typecheck step.",
  );
  process.exit(0);
}

const result = spawnSync(command, args, {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error) {
  throw result.error;
}

if (result.signal) {
  console.error(`Workspace build terminated by signal ${result.signal}.`);
}

process.exit(result.status ?? 1);
