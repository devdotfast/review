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
  if (!url || !token) return;
  try {
    const body = await readStdin();
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
