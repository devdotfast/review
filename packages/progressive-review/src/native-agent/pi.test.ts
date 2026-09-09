import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { PiAgentServer } from "./pi";

it("buffers new Pi messages, deduplicates delivery, and binds each resumed Ask without branch replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "review-pi-"));
  const server = new PiAgentServer({
    runtimeDirectory: directory,
    desktopEndpoint: { baseUrl: "http://localhost:4000", token: "test" },
  });
  try {
    const launch = await server.launch({
      session: { forkOf: "parent" },
      prompt: { id: "ask", text: "question" },
      cwd: directory,
    });
    const post = async (
      command: typeof launch.command,
      id: string,
      role: string,
      body: string,
    ) =>
      fetch(command.env.DEV_FAST_REVIEW_AGENT_BRIDGE_URL!, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-review-token": command.env.DEV_FAST_REVIEW_AGENT_BRIDGE_TOKEN!,
        },
        body: JSON.stringify({
          sessionId: launch.sessionId,
          review_launch_id: command.env.DEV_FAST_REVIEW_AGENT_LAUNCH_ID,
          type: "message.updated",
          message: { id, role, body, createdAt: "2026-01-01T00:00:00Z" },
        }),
      });
    expect(
      (await post(launch.command, "native-event-1", "user", "question")).status,
    ).toBe(200);
    await post(launch.command, "native-event-1", "user", "question");
    await post(launch.command, "native-event-2", "assistant", "answer");
    const stream = await server.updates(launch.sessionId);
    const iterator = stream.updates[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({
      message: { id: "ask", body: "question" },
    });
    expect((await iterator.next()).value).toMatchObject({
      message: { body: "answer" },
    });
    await server.interrupt(launch.sessionId);
    expect((await iterator.next()).value).toMatchObject({
      status: "interrupted",
    });
    const resumed = await server.launch({
      session: { resume: launch.sessionId },
      prompt: { id: "ask2", text: "again" },
      cwd: directory,
    });
    await post(launch.command, "late", "assistant", "stale");
    await post(resumed.command, "new-event", "user", "again");
    expect((await iterator.next()).value).toMatchObject({
      message: { id: "ask2", body: "again" },
    });
    await stream.close();
    await post(resumed.command, "offline", "assistant", "offline answer");
    const reopened = await server.launch({
      session: { resume: launch.sessionId },
      prompt: { id: "reopened", text: "new question" },
      cwd: directory,
    });
    const replacement = await server.updates(launch.sessionId);
    await stream.close();
    await post(resumed.command, "old-generation", "assistant", "stale answer");
    await post(reopened.command, "new-observer", "user", "new question");
    expect(
      (await replacement.updates[Symbol.asyncIterator]().next()).value,
    ).toMatchObject({ message: { id: "reopened", body: "new question" } });
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
