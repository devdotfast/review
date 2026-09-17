import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { openLocalReviewStore } from "../../../src/review-api/local-data.js";

export async function createShareFixture(root: string) {
  const repo = path.join(root, "sender-repository");
  await mkdir(repo, { recursive: true });

  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  git("init");
  git("config", "user.name", "Review fixture");
  git("config", "user.email", "fixture@example.invalid");
  await writeFile(
    path.join(repo, "answer.ts"),
    "export function answer() {\n  return 1;\n}\n",
  );
  await writeFile(
    path.join(repo, "removed.ts"),
    "export const obsolete = true;\n",
  );
  git("add", ".");
  git("commit", "-m", "Initial answer");
  const base = git("rev-parse", "HEAD");
  await writeFile(
    path.join(repo, "answer.ts"),
    "export function answer() {\n  return 42;\n}\n",
  );
  await writeFile(path.join(repo, "new.ts"), "export const added = true;\n");
  git("rm", "removed.ts");
  git("add", ".");
  git("commit", "-m", "Answer and cleanup");
  const head = git("rev-parse", "HEAD");
  const local = openLocalReviewStore(path.join(root, "sender.db"));
  const registered = await local.data.register(repo);
  const pins = { repositoryId: registered.id, base, head };

  const created = await local.store.execute({
    commandId: randomUUID(),
    operation: { type: "create", title: "Sharing pinned commits", pins },
  });

  const traceId = randomUUID(),
    imageId = randomUUID(),
    mapId = randomUUID();

  await local.data.upload({
    kind: "trace",
    id: traceId,
    repositoryId: registered.id,
    trace: {
      label: "Why the answer changed",
      events: [
        { id: "request", role: "user", text: "Please compute the answer." },
        {
          id: "response",
          role: "assistant",
          text: "The answer is 42. This entire conversation is retained.",
        },
      ],
    },
  });
  await local.data.upload({
    kind: "image",
    id: imageId,
    repositoryId: registered.id,
    base64: (
      await sharp({
        create: { width: 24, height: 24, channels: 4, background: "#e5484d" },
      })
        .png()
        .toBuffer()
    ).toString("base64"),
  });
  await local.data.upload({
    kind: "map",
    id: mapId,
    repositoryId: registered.id,
    pins,
    side: "head",
    model: {
      systems: {
        app: {
          label: "Answer service",
          containers: {
            runtime: {
              components: {
                answer: {
                  coverage: { files: ["answer.ts"] },
                  codeElements: {
                    compute: {
                      sourceRanges: [
                        { file: "answer.ts", fromLine: 1, toLine: 3 },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  const blocks = [
    {
      type: "markdown",
      markdown:
        "# A portable review\n\nThis review reads pinned GitHub commits and retains its image, map and complete trace.",
    },
    {
      type: "code_peek",
      source: { side: "head", file: "answer.ts", fromLine: 1, toLine: 3 },
    },
    {
      type: "trace_quote",
      traceId,
      eventId: "response",
      text: "The answer is 42.",
    },
    { type: "image", assetId: imageId, alt: "Embedded red pixel" },
    { type: "software_map", mapVersionId: mapId },
    {
      type: "code_peek",
      source: { side: "head", file: "new.ts", fromLine: 1, toLine: 1 },
    },
    {
      type: "code_peek",
      source: { side: "base", file: "removed.ts", fromLine: 1, toLine: 1 },
    },
  ];

  for (const content of blocks)
    await local.store.execute({
      commandId: randomUUID(),
      operation: {
        type: "edit",
        reviewId: created.reviewId,
        edit: { type: "insert", content },
      },
    });

  return {
    ...local,
    repo,
    reviewId: created.reviewId,
    repository: { cloneUrl: "https://github.com/fixture/review.git" },
  };
}
