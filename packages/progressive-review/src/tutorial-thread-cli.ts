import type { Writable } from "node:stream";

import { ReviewCommentThreadRecordSchema } from "@dev.fast/review-protocol";
import { EnvHttpProxyAgent } from "undici";
import { z } from "zod";

import {
  REVIEW_AGENT_THREAD_TOKEN_ENV,
  REVIEW_AGENT_THREAD_URL_ENV,
} from "./native-agent/terminal-command";

const TutorialThreadSchema = z.strictObject({
  tutorial: z.literal(true),
  review: z.string().min(1),
  state: z.enum(["draft", "submitted"]),
  comment: ReviewCommentThreadRecordSchema,
});
const responseByteLimit = 2 * 1024 * 1024;

/** Attached legacy tutorial only; deliberately has no discovery or disk fallback. */
export async function runTutorialThreadCli(input: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  stdout: Writable;
}): Promise<number> {
  const threadId = input.argv[0];
  if (input.argv.length !== 1 || !threadId || !/^[\w-]{1,200}$/u.test(threadId))
    return failure(input.stdout, "Usage: review internal-thread <threadId>.");

  const env = input.env ?? process.env;
  const attachedUrl = env[REVIEW_AGENT_THREAD_URL_ENV];
  const token = env[REVIEW_AGENT_THREAD_TOKEN_ENV];
  if (!attachedUrl || !token)
    return failure(
      input.stdout,
      "This utility requires an attached Review Desktop tutorial question. Normal questions use review host queries.",
    );
  let url: URL;
  try {
    url = new URL(attachedUrl);
  } catch {
    return failure(input.stdout, "Invalid attached tutorial connection.");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["/agent-threads", "/agent-threads/"].includes(url.pathname) ||
    token.length > 4096 ||
    /[\s\u0000-\u001f\u007f]/u.test(token)
  )
    return failure(input.stdout, "Invalid attached tutorial connection.");
  url.pathname = `/agent-threads/${encodeURIComponent(threadId)}`;
  url.searchParams.set("scope", "tutorial");
  // Keep support for the native terminal's sandbox proxy local to this read.
  const dispatcher = new EnvHttpProxyAgent({
    httpProxy: env.http_proxy ?? env.HTTP_PROXY,
    httpsProxy: env.https_proxy ?? env.HTTPS_PROXY,
    noProxy: env.no_proxy ?? env.NO_PROXY,
  });
  try {
    const options = { dispatcher };
    const response = await fetch(url, {
      ...options,
      headers: { "x-review-token": token },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return failure(
        input.stdout,
        "Review Desktop did not authorize or find this tutorial question.",
      );
    }
    const parsed = TutorialThreadSchema.safeParse(
      JSON.parse(await readThreadBody(response)),
    );
    if (!parsed.success || parsed.data.comment.threadId !== threadId)
      return failure(
        input.stdout,
        "Review Desktop returned an invalid tutorial question.",
      );
    input.stdout.write(`${JSON.stringify(parsed.data)}\n`);
    return 0;
  } catch {
    return failure(
      input.stdout,
      "Review Desktop could not read the tutorial question.",
    );
  } finally {
    await dispatcher.close();
  }
}

async function readThreadBody(response: Response): Promise<string> {
  if (!response.body) throw new Error("Missing response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > responseByteLimit) throw new Error("Response too large");
      chunks.push(part.value);
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

function failure(stdout: Writable, message: string): number {
  stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  return 1;
}
