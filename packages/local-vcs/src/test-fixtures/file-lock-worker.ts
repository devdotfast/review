import { appendFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { withFileLock } from "../file-lock";

const [lockPath, logPath, barrierPath, actor, holdMsInput] =
  process.argv.slice(2);
if (!lockPath || !logPath || !barrierPath || !actor) {
  throw new Error(
    "Usage: file-lock-worker <lock-path> <log-path> <barrier-path> <actor>",
  );
}

appendFileSync(logPath, `${actor}:ready\n`);
while (!existsSync(barrierPath)) {
  await sleep(10);
}

await withFileLock(
  {
    lockPath,
    pollMs: 20,
    staleMs: 2_000,
    timeoutMs: 5_000,
    updateMs: 1_000,
  },
  async () => {
    appendFileSync(logPath, `${actor}:start\n`);
    await sleep(holdMsInput ? Number(holdMsInput) : 200);
    appendFileSync(logPath, `${actor}:end\n`);
  },
);
