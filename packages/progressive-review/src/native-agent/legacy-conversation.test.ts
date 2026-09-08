import { expect, it } from "vitest";

import { reviewCommentPromptPrefix } from "../review-comment-agent";
import { recoverLegacyConversation } from "./legacy-conversation";
import type { NativeReviewMessage } from "./native-session";

const binding = { harness: "codex" as const, sessionId: "fork" };
const thread = {
  threadId: "review-thread",
  messages: [
    { id: "local-ask", role: "reviewer", body: "Explain", by: "Reviewer" },
    { id: "local-answer-1", role: "agent", body: "Same answer", by: "Codex" },
    { id: "local-followup", role: "reviewer", body: "Again", by: "Reviewer" },
    { id: "local-answer-2", role: "agent", body: "Same answer", by: "Codex" },
  ],
};
const message = (
  id: string,
  role: NativeReviewMessage["role"],
  body: string,
): NativeReviewMessage => ({
  id,
  role,
  body,
  createdAt: "2026-09-08T00:00:00Z",
});
const native = [
  message("inherited", "user", "Other task"),
  message(
    "ask",
    "user",
    reviewCommentPromptPrefix(thread.threadId) + "Explain",
  ),
  message("answer-1", "assistant", "Same answer"),
  message(
    "followup",
    "user",
    reviewCommentPromptPrefix(thread.threadId) + "Again",
  ),
  message("answer-2", "assistant", "Same answer"),
];

it("recovers repeated replies by conversation order while preserving local messages", () => {
  const recovered = recoverLegacyConversation(thread, binding, native);
  expect(recovered).toEqual({
    ...thread,
    agentSession: { ...binding, firstMessageId: "ask" },
    messages: thread.messages.map((stored, i) => ({
      ...stored,
      agentInput: i === 0 || i === 2,
      agentMessage: {
        sessionId: "fork",
        messageId: ["ask", "answer-1", "followup", "answer-2"][i],
      },
    })),
  });
});

it("rejects ambiguous identical replies instead of assigning an arbitrary identity", () => {
  expect(
    recoverLegacyConversation(thread, binding, [
      ...native,
      message("another-answer", "assistant", "Same answer"),
    ]),
  ).toBeNull();
});

it("does not recover from another thread's marker or mismatched stored messages", () => {
  expect(
    recoverLegacyConversation(
      { ...thread, threadId: "different" },
      binding,
      native,
    ),
  ).toBeNull();
  expect(
    recoverLegacyConversation(
      {
        ...thread,
        messages: [{ role: "reviewer", body: "Not this question" }],
      },
      binding,
      native,
    ),
  ).toBeNull();
});
