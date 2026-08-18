import { appendFile, stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { withLocalVcsBuildLock } from "../../scripts/build.mjs";

const [lockPath, logPath, barrierPath, actor] = process.argv.slice(2);

await appendFile(logPath, `${actor}:ready\n`);
while (!(await stat(barrierPath).catch(() => undefined))) {
  await sleep(10);
}

await withLocalVcsBuildLock(
  async () => {
    await appendFile(logPath, `${actor}:start\n`);
    await sleep(150);
    await appendFile(logPath, `${actor}:end\n`);
  },
  {
    lockPath,
    pollMs: 10,
    staleMs: 2_000,
    timeoutMs: 5_000,
    updateMs: 1_000,
  },
);
