import { readFile, rm, stat, writeFile } from "node:fs/promises";

import { sessionIdSchema } from "@dev-fast/trace-shared";

export const TRACE_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

export async function readActiveTraceSessions(
  filePath: string,
  now = Date.now(),
): Promise<Map<string, number>> {
  const [content, fileStat] = await Promise.all([
    readFile(filePath, "utf8").catch(() => ""),
    stat(filePath).catch(() => null),
  ]);
  const legacyTimestamp = Math.floor(fileStat?.mtimeMs ?? now);
  const sessions = new Map<string, number>();

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.split("\t");
    const parsedSessionId = sessionIdSchema.safeParse(fields[0]);
    if (!parsedSessionId.success) continue;
    const sessionId = parsedSessionId.data;

    let lastActiveAt = legacyTimestamp;
    if (fields.length > 1) {
      if (fields.length !== 2 || !/^\d+$/.test(fields[1] ?? "")) continue;
      lastActiveAt = Number(fields[1]);
      if (!Number.isSafeInteger(lastActiveAt) || lastActiveAt <= 0) continue;
    }
    if (now - lastActiveAt <= TRACE_SESSION_TTL_MS) {
      sessions.set(sessionId, lastActiveAt);
    }
  }

  return sessions;
}

export async function writeTraceSessions(
  filePath: string,
  sessions: ReadonlyMap<string, number>,
): Promise<void> {
  if (sessions.size === 0) {
    await rm(filePath, { force: true });
    return;
  }
  const content = [...sessions]
    .map(([sessionId, lastActiveAt]) => `${sessionId}\t${lastActiveAt}`)
    .join("\n");
  await writeFile(filePath, `${content}\n`, "utf8");
}
