import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";

import { normalizeStoreOrigin } from "./store-origin";

export const HOSTED_CAPTURE_SCOPE_NOTICE =
  "Other repositories do not capture to hosted storage. S3 auto-activation applies only to the bucket. Enable another repository only when the user explicitly requests publication.\n";

/** Informational only: no network access, consent writes, or transfers. */
export async function notifySkippedHostedCapture(input: {
  origin: string;
  repository: string;
  devHome: string;
  stdout: Writable;
}): Promise<void> {
  const origin = normalizeStoreOrigin(input.origin);

  const key = createHash("sha256")
    .update(`${origin}\n${input.repository.toLowerCase()}`)
    .digest("hex");

  const directory = path.join(input.devHome, "trace", "notices");
  await mkdir(directory, { recursive: true, mode: 0o700 });

  try {
    await writeFile(
      path.join(directory, `${key}.json`),
      JSON.stringify({ version: 1, notifiedAt: new Date().toISOString() }),
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      return;
    throw error;
  }

  input.stdout.write(
    `Hosted trace capture is off for ${input.repository} at ${origin}. Run \`review trace status\` for details. Enable publication only when the user explicitly requests it.\n`,
  );
}
