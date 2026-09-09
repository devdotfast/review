import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const HOOK_URL_ENV = "DEV_FAST_REVIEW_AGENT_HOOK_URL";
const HOOK_TOKEN_ENV = "DEV_FAST_REVIEW_AGENT_HOOK_TOKEN";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function sendNativeAgentHook(): Promise<void> {
  const url = process.env[HOOK_URL_ENV];
  const token = process.env[HOOK_TOKEN_ENV];
  const launchId = process.env.DEV_FAST_REVIEW_AGENT_LAUNCH_ID;
  if (!url || !token || !launchId)
    throw new Error("Review hook requires URL, token, and launch ID.");
  try {
    const payload = JSON.parse(await readStdin());
    const body = JSON.stringify({
      ...payload,
      review_event_id: randomUUID(),
      review_launch_id: launchId,
    });
    await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-review-token": token,
      },
      body,
    });
  } catch {
    // Observation is fail-open. Native agent work must continue.
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await sendNativeAgentHook();
}
