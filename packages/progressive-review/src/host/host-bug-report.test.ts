import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import {
  HOST_COMMAND_DEFINITIONS,
  HostBugReportInputSchema,
  type HostCommandName,
  HostCommandSchema,
  HostMapVersionSchema,
  type HostSupportReport,
  type JsonValue,
} from "@dev.fast/review-protocol";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BugReportPayload } from "../server/bug-report";
import { submitHostBugReport } from "./host-bug-report";
import { type HostAccess, ReviewHost } from "./review-host";
import { ReviewHostStore } from "./review-host-store";

const directories: string[] = [],
  stores: ReviewHostStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function commit(root: string) {
  git(root, "add", "--all");
  git(root, "commit", "-m", "Fixture");
  return git(root, "rev-parse", "HEAD");
}
const report: HostSupportReport = {
  description: "",
  include_review: false,
  include_map: false,
  include_diff: false,
  app_session_id: "support-test-session",
  app_version: "development",
};
async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "host-support-"));
  directories.push(directory);
  const repositoryPath = path.join(directory, "repository");
  mkdirSync(repositoryPath);
  git(repositoryPath, "init", "-b", "main");
  git(repositoryPath, "config", "user.name", "Review Test");
  git(repositoryPath, "config", "user.email", "review@example.invalid");
  git(repositoryPath, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(repositoryPath, "file.ts"), "old\n");
  const ancestor = commit(repositoryPath);
  writeFileSync(
    path.join(repositoryPath, "base-only.ts"),
    "only in exact base\n",
  );
  const base = commit(repositoryPath);
  git(repositoryPath, "checkout", "-b", "feature", ancestor);
  writeFileSync(path.join(repositoryPath, "file.ts"), "new\n");
  const head = commit(repositoryPath);
  const store = new ReviewHostStore(path.join(directory, "review.db"));
  stores.push(store);
  const host = new ReviewHost(store);
  const access: HostAccess = {
    principal: { id: randomUUID(), kind: "human", displayName: "Reviewer" },
    permissions: new Set(["human", "author", "read", "register_repository"]),
  };
  const envelope = {
    apiVersion: 1,
    hostId: store.hostId,
    workspaceId: store.workspaceId,
    clientId: randomUUID(),
  };
  const command = (type: HostCommandName, input: JsonValue) =>
    host.command(
      access,
      HostCommandSchema.parse({
        ...envelope,
        commandId: randomUUID(),
        type,
        input,
      }),
    );
  const repository = HOST_COMMAND_DEFINITIONS[
    "repository.register"
  ].result.parse(
    (await command("repository.register", { path: repositoryPath })).result,
  );
  const { review } = HOST_COMMAND_DEFINITIONS["review.create"].result.parse(
    (
      await command("review.create", {
        repositoryId: repository.id,
        title: "Original title",
        change: { kind: "range", baseRef: base, headRef: head },
      })
    ).result,
  );
  const createMap = async (label: string, description = "") =>
    HostMapVersionSchema.parse(
      (
        await command("map.create", {
          reviewId: review.id,
          reviewVersion: 0,
          side: "head",
          map: {
            schemaVersion: 1,
            elements: {
              app: {
                id: "app",
                parentId: null,
                kind: "component",
                label,
                description,
                source: [],
              },
            },
            relationships: {},
          },
        })
      ).result,
    );
  const uploaded: BugReportPayload[] = [];
  const upload = vi.fn<typeof fetch>(async (_url, init) => {
    if (!(init?.body instanceof FormData))
      throw new Error("Expected multipart report");
    const payload = init.body.get("payload");
    if (!(payload instanceof Blob))
      throw new Error("Expected compressed payload");
    uploaded.push(
      JSON.parse(
        gunzipSync(Buffer.from(await payload.arrayBuffer())).toString("utf8"),
      ),
    );
    return Response.json({
      ok: true,
      report_id: randomUUID(),
      short_id: "123456789012",
    });
  });
  const submit = (
    reviewVersion = 0,
    selection: Partial<HostSupportReport> = {},
    fetchImpl = upload,
  ) =>
    submitHostBugReport({
      host,
      access,
      workspaceId: store.workspaceId,
      reviewId: review.id,
      body: { reviewVersion, report: { ...report, ...selection } },
      fetchImpl,
    });
  return {
    directory,
    repositoryPath,
    store,
    host,
    access,
    command,
    review,
    base,
    head,
    createMap,
    uploaded,
    upload,
    submit,
  };
}

describe("snapshot support reports", () => {
  it("attaches only selected and embedded immutable maps, exact source diffs and saved review metadata", async () => {
    const f = await fixture();
    const selected = await f.createMap("Selected");
    const embedded = await f.createMap("Embedded");
    await f.command("review.update", {
      reviewId: f.review.id,
      expectedReviewVersion: 0,
      mapVersions: { head: selected.id },
    });
    await f.command("document.mutate", {
      reviewId: f.review.id,
      expectedReviewVersion: 1,
      operations: [
        {
          op: "node.insert",
          node: { id: "map", type: "software_map", mapVersionId: embedded.id },
          placement: { parentId: null, position: { kind: "end" } },
        },
      ],
    });
    await f.command("map.mutate", {
      reviewId: f.review.id,
      mapId: selected.mapId,
      expectedMapVersion: 0,
      operations: [
        {
          op: "element.put",
          element: {
            ...selected.elements.app!,
            source: [],
            label: "Not selected later",
          },
        },
      ],
    });
    await f.command("review.update", {
      reviewId: f.review.id,
      expectedReviewVersion: 2,
      title: "Not the observed title",
    });
    writeFileSync(path.join(f.repositoryPath, "file.ts"), "uncommitted poison");
    const result = await f.submit(2, {
      include_review: true,
      include_map: true,
      include_diff: true,
    });
    expect(result.warnings).toEqual([]);
    const payload = f.uploaded[0]!;
    expect(JSON.parse(payload.review!["review.json"]!)).toMatchObject({
      reviewVersion: 2,
      title: "Original title",
    });
    expect(
      JSON.parse(payload.map!)
        .map((map: { id: string }) => map.id)
        .sort(),
    ).toEqual([selected.id, embedded.id].sort());
    expect(payload.diff).toMatchObject({
      baseRef: f.base,
      headRef: f.head,
      files: expect.arrayContaining([
        expect.objectContaining({ path: "base-only.ts", status: "deleted" }),
      ]),
    });
    expect(JSON.stringify(payload)).not.toContain("uncommitted poison");
    expect(JSON.stringify(payload)).not.toContain("Not selected later");
    await f.submit(2, { include_map: true });
    expect(f.uploaded[1]).toHaveProperty("map");
    expect(f.uploaded[1]).not.toHaveProperty("review");
    expect(f.uploaded[1]).not.toHaveProperty("diff");
    await f.submit(2, { include_review: true });
    expect(f.uploaded[2]).toHaveProperty("review");
    expect(f.uploaded[2]).not.toHaveProperty("map");
  });

  it("reports unavailable authorized attachments without replacements and does not read unconsented source", async () => {
    const f = await fixture();
    renameSync(f.repositoryPath, path.join(f.directory, "offline"));
    expect((await f.submit(0, { include_diff: true })).warnings).toEqual([
      expect.objectContaining({ attachment: "diff", code: "unavailable" }),
    ]);
    expect(f.uploaded[0]).not.toHaveProperty("diff");
    expect((await f.submit()).warnings).toEqual([]);
    await expect(f.submit(99, { include_review: true })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(f.upload).toHaveBeenCalledTimes(2);
  });

  it("accepts one fully decoded JPEG and rejects fake, noncanonical, wrong-format and oversized screenshots", async () => {
    const f = await fixture();
    const create = sharp({
      create: { width: 3, height: 2, channels: 3, background: "red" },
    });
    const jpeg = await create.clone().jpeg().toBuffer();
    const png = await create.clone().png().toBuffer();
    for (const bytes of [
      Buffer.from("pretend screenshot"),
      png,
      jpeg.subarray(0, 30),
    ])
      await expect(
        f.submit(0, {
          screenshot: { mime: "image/jpeg", base64: bytes.toString("base64") },
        }),
      ).rejects.toMatchObject({ name: "HostDocumentValidationError" });
    await expect(
      f.submit(0, { screenshot: { mime: "image/jpeg", base64: "AB==" } }),
    ).rejects.toThrow(/canonical/);
    await expect(
      f.submit(0, {
        screenshot: {
          mime: "image/jpeg",
          base64: Buffer.alloc(3 * 1024 * 1024 + 3).toString("base64"),
        },
      }),
    ).rejects.toThrow(/base64/);
    expect(f.upload).not.toHaveBeenCalled();
    await f.submit(0, {
      screenshot: { mime: "image/jpeg", base64: jpeg.toString("base64") },
    });
    expect(f.uploaded[0]!.screenshot!.base64).toBe(jpeg.toString("base64"));
    expect(() =>
      HostBugReportInputSchema.parse({
        reviewVersion: 0,
        report: { ...report, include_trace: true },
      }),
    ).toThrow(/include_trace/);
  });

  it("never automatically retries an uncertain external upload", async () => {
    const f = await fixture();
    f.upload.mockRejectedValue(new Error("Connection lost after submission"));
    await expect(f.submit()).rejects.toThrow(/Connection lost/);
    expect(f.upload).toHaveBeenCalledTimes(1);
  });

  it("returns a size-limit warning when the uploader must omit the consented map attachment", async () => {
    const f = await fixture();
    const ids: string[] = [];
    for (let index = 0; index < 6; index++) {
      const elements = Object.fromEntries(
        Array.from({ length: 10 }, (_, element) => [
          `e${element}`,
          {
            id: `e${element}`,
            parentId: null,
            kind: "component",
            label: "Large map element",
            source: [],
            description: randomBytes(180_000).toString("base64"),
          },
        ]),
      );
      const map = HostMapVersionSchema.parse(
        (
          await f.command("map.create", {
            reviewId: f.review.id,
            reviewVersion: 0,
            side: "head",
            map: { schemaVersion: 1, elements, relationships: {} },
          })
        ).result,
      );
      ids.push(map.id);
    }
    await f.command("document.mutate", {
      reviewId: f.review.id,
      expectedReviewVersion: 0,
      operations: ids.map((mapVersionId, index) => ({
        op: "node.insert",
        node: { id: `map${index}`, type: "software_map", mapVersionId },
        placement: { parentId: null, position: { kind: "end" } },
      })),
    });
    const result = await f.submit(1, {
      include_review: true,
      include_map: true,
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({ attachment: "map", code: "size_limit" }),
    ]);
    expect(f.uploaded[0]).not.toHaveProperty("map");
    expect(f.uploaded[0]).toHaveProperty("review");
    expect(f.upload).toHaveBeenCalledTimes(1);
  });
});
