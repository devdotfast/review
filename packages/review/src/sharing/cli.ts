import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";

import { z } from "zod";

import { connectReviewApi } from "../review-api/agent-client.js";

const resultSchema = z.strictObject({
  shareId: z.uuid(),
  version: z.number().int(),
  url: z.url(),
});

export async function runShareCli(input: {
  review?: string;
  product?: "review" | "whiteboard";
  version?: string;
  requestId?: string;
  preview?: boolean;
  revoke?: string;
  json?: boolean;
  env?: NodeJS.ProcessEnv;
  stdout: Writable;
  stderr: Writable;
}) {
  const vocabulary = input.product === "whiteboard" ? "session" : "review";

  try {
    const client = await connectReviewApi(input.env, vocabulary);

    if (input.revoke) {
      const result = z
        .strictObject({ shareId: z.uuid(), revoked: z.literal(true) })
        .parse(await client.post("/sharing/revoke", { shareId: input.revoke }));

      input.stdout.write(
        input.json
          ? JSON.stringify(result) + "\n"
          : "Share revoked. Existing downloads remain available offline.\n",
      );
    } else {
      if (!input.review)
        throw new Error(
          `Use ${input.product ?? "review"} share --${vocabulary} <id>.`,
        );

      const version =
        input.version === undefined
          ? undefined
          : z.number().int().nonnegative().parse(Number(input.version));

      input.stderr.write(
        "Sharing includes retained images, maps, and full trace conversations. Anyone with the link can download them. Recipients need GitHub repository access to fetch the pinned commits.\n",
      );

      const result = resultSchema.parse(
        await client.post("/sharing/publish", {
          [`${vocabulary}Id`]: input.review,
          version,
          requestId:
            input.requestId === undefined
              ? randomUUID()
              : z.uuid().parse(input.requestId),
        }),
      );

      if (input.preview) {
        const url = new URL(result.url);
        url.searchParams.set("app", "preview");
        result.url = url.href;
      }

      input.stdout.write(
        input.json ? JSON.stringify(result) + "\n" : result.url + "\n",
      );
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sharing failed.";

    if (input.json)
      input.stdout.write(
        JSON.stringify({ error: { code: "share_failed", message } }) + "\n",
      );
    input.stderr.write(message + "\n");

    return 1;
  }
}
