import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { ClaudeAgentServer } from "./claude-code";

it("captures prompt and final hooks before subscription, continues after resume, and ignores the closed terminal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "review-claude-"));
  const server = new ClaudeAgentServer({
    runtimeDirectory: directory,
    desktopEndpoint: { baseUrl: "http://localhost:4000", token: "test" },
  });
  try {
    const launch = await server.launch({
      session: { forkOf: "parent" },
      prompt: { id: "review-ask", text: "question" },
      cwd: directory,
    });
    const post = async (
      command: typeof launch.command,
      event: {
        hook_event_name: string;
        prompt?: string;
        last_assistant_message?: string;
        error?: string;
      },
    ) =>
      fetch(command.env.DEV_FAST_REVIEW_AGENT_HOOK_URL!, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-review-token": command.env.DEV_FAST_REVIEW_AGENT_HOOK_TOKEN!,
        },
        body: JSON.stringify({
          session_id: launch.sessionId,
          review_launch_id: command.env.DEV_FAST_REVIEW_AGENT_LAUNCH_ID,
          review_event_id: randomUUID(),
          ...event,
        }),
      });
    expect(
      (
        await post(launch.command, {
          hook_event_name: "UserPromptSubmit",
          prompt: "question",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(launch.command, {
          hook_event_name: "Stop",
          last_assistant_message: "answer",
        })
      ).status,
    ).toBe(200);
    const stream = await server.updates(launch.sessionId);
    const iterator = stream.updates[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({
      type: "message.updated",
      message: { id: "review-ask", role: "user", body: "question" },
    });
    expect((await iterator.next()).value).toMatchObject({ status: "running" });
    expect((await iterator.next()).value).toMatchObject({
      message: { role: "assistant", body: "answer" },
    });
    expect((await iterator.next()).value).toMatchObject({ status: "idle" });
    await server.interrupt(launch.sessionId);
    expect((await iterator.next()).value).toMatchObject({
      status: "interrupted",
    });
    const resumed = await server.launch({
      session: { resume: launch.sessionId },
      prompt: { id: "followup", text: "again" },
      cwd: directory,
    });
    await post(launch.command, {
      hook_event_name: "Stop",
      last_assistant_message: "stale response",
    });
    await post(resumed.command, {
      hook_event_name: "UserPromptSubmit",
      prompt: "again",
    });
    expect((await iterator.next()).value).toMatchObject({
      message: { id: "followup", body: "again" },
    });
    expect((await iterator.next()).value).toMatchObject({ status: "running" });
    await post(resumed.command, {
      hook_event_name: "StopFailure",
      error: "rate_limit",
    });
    expect((await iterator.next()).value).toMatchObject({
      status: "failed",
      error: "rate_limit",
    });
    await post(resumed.command, {
      hook_event_name: "UserPromptSubmit",
      prompt: "TUI question",
    });
    const followup = (await iterator.next()).value;
    expect(followup).toMatchObject({ message: { body: "TUI question" } });
    expect(followup).toMatchObject({
      message: { id: expect.not.stringMatching(/^followup$/) },
    });
    await stream.close();
    await post(resumed.command, {
      hook_event_name: "Stop",
      last_assistant_message: "offline answer",
    });
    const reopened = await server.launch({
      session: { resume: launch.sessionId },
      prompt: { id: "reopened", text: "new question" },
      cwd: directory,
    });
    const replacement = await server.updates(launch.sessionId);
    await stream.close(); // A late disposal cannot close the replacement observer.
    await post(resumed.command, {
      hook_event_name: "Stop",
      last_assistant_message: "old generation",
    });
    await post(reopened.command, {
      hook_event_name: "UserPromptSubmit",
      prompt: "new question",
    });
    const received = await replacement.updates[Symbol.asyncIterator]().next();
    expect(received.value).toMatchObject({
      message: { id: "reopened", body: "new question" },
    });
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
