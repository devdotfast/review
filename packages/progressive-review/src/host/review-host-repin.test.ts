import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  HOST_COMMAND_DEFINITIONS,
  HOST_QUERY_DEFINITIONS,
  type HostCommandName,
  HostCommandSchema,
  type HostQueryInputs,
  type HostQueryName,
  HostQuerySchema,
  type JsonValue,
} from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

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
function commit(root: string, message: string) {
  git(root, "add", "--all");
  git(root, "commit", "--date=2026-09-10T10:30:00-04:00", "-m", message);
  return git(root, "rev-parse", "HEAD");
}
async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "review-source-"));
  directories.push(directory);
  const repositoryPath = path.join(directory, "repository");
  mkdirSync(path.join(repositoryPath, "src"), { recursive: true });
  git(repositoryPath, "init", "-b", "main");
  git(repositoryPath, "config", "user.name", "Review Test");
  git(repositoryPath, "config", "user.email", "review@example.invalid");
  git(repositoryPath, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(repositoryPath, "README.md"), "Review fixture\n");
  writeFileSync(path.join(repositoryPath, "src/file.ts"), "one();\ntwo();\n");
  writeFileSync(path.join(repositoryPath, "src/other.ts"), "oldOther();\n");
  const base = commit(repositoryPath, "Base");
  writeFileSync(
    path.join(repositoryPath, "src/file.ts"),
    "feature();\ntwo();\n",
  );
  const firstHead = commit(repositoryPath, "Add feature");
  writeFileSync(path.join(repositoryPath, "src/other.ts"), "newOther();\n");
  const head = commit(repositoryPath, "Update other file");
  const store = new ReviewHostStore(path.join(directory, "review.db"));
  stores.push(store);
  const host = new ReviewHost(store);
  const author: HostAccess = {
    principal: { id: randomUUID(), kind: "agent", displayName: "Author" },
    permissions: new Set(["author", "read", "register_repository"]),
  };
  const envelope = {
    apiVersion: 1,
    hostId: store.hostId,
    workspaceId: store.workspaceId,
    clientId: randomUUID(),
  };
  const command = (type: HostCommandName, input: JsonValue) =>
    host.command(
      author,
      HostCommandSchema.parse({
        ...envelope,
        type,
        input,
        commandId: randomUUID(),
      }),
    );
  const query = async <K extends HostQueryName>(
    type: K,
    input: HostQueryInputs[K],
  ) =>
    HOST_QUERY_DEFINITIONS[type].result.parse(
      (
        await host.query(
          author,
          HostQuerySchema.parse({ ...envelope, type, input }),
        )
      ).result,
    ) as ReturnType<(typeof HOST_QUERY_DEFINITIONS)[K]["result"]["parse"]>;
  const repository = HOST_COMMAND_DEFINITIONS[
    "repository.register"
  ].result.parse(
    (await command("repository.register", { path: repositoryPath })).result,
  );
  const create = async () =>
    HOST_COMMAND_DEFINITIONS["review.create"].result.parse(
      (
        await command("review.create", {
          repositoryId: repository.id,
          title: "Pinned source",
          change: { kind: "range", baseRef: base, headRef: head },
        })
      ).result,
    );
  const { review } = await create();
  await command("review.update", {
    reviewId: review.id,
    expectedReviewVersion: 0,
    title: "Saved pinned source",
  });
  const input = { reviewId: review.id, reviewVersion: 1 };
  return {
    directory,
    repositoryPath,
    base,
    firstHead,
    head,
    command,
    query,
    review,
    create,
    input,
  };
}

describe("versioned source API", () => {
  it("serves complete files and excerpts against a commit and first parent, with separately scoped diff cursors", async () => {
    const f = await fixture();
    const input = {
      ...f.input,
      file: "src/other.ts",
      comparisonCommit: f.head,
    };
    expect(
      await f.query("source.read", { ...input, side: "base" }),
    ).toMatchObject({
      commit: f.firstHead,
      text: "oldOther();\n",
      range: null,
    });
    expect(
      await f.query("source.read", {
        ...input,
        side: "head",
        range: { fromLine: 1, toLine: 1 },
      }),
    ).toMatchObject({
      commit: f.head,
      text: "newOther();",
      range: { fromLine: 1, toLine: 1 },
    });
    const scoped = await f.query("source.diff", {
      ...f.input,
      comparisonCommit: f.head,
    });
    expect(scoped.items.map((file) => file.path)).toEqual(["src/other.ts"]);
    const first = await f.query("source.diff", { ...f.input, limit: 1 });
    await expect(
      f.query("source.diff", {
        ...f.input,
        comparisonCommit: f.head,
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
    await expect(
      f.query("source.read", {
        ...input,
        side: "head",
        comparisonCommit: f.base,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("normalizes offset-bearing commit dates and pages commits newest-first and diff paths ascending", async () => {
    const f = await fixture();
    expect(git(f.repositoryPath, "show", "-s", "--format=%aI", f.head)).toBe(
      "2026-09-10T10:30:00-04:00",
    );
    const input = { ...f.input, limit: 1 };
    const first = await f.query("source.commits", input);
    expect(first.items).toEqual([
      expect.objectContaining({
        oid: f.head,
        at: "2026-09-10T14:30:00.000Z",
        subject: "Update other file",
      }),
    ]);
    const next = await f.query("source.commits", {
      ...input,
      cursor: first.nextCursor!,
    });
    expect(next.items.map((item) => item.oid)).toEqual([f.firstHead]);
    expect(next.nextCursor).toBeNull();
    const diff = await f.query("source.diff", input);
    expect(diff.items).toEqual([
      expect.objectContaining({
        path: "src/file.ts",
        additions: 1,
        deletions: 1,
        binary: false,
      }),
    ]);
    const diffNext = await f.query("source.diff", {
      ...input,
      cursor: diff.nextCursor!,
    });
    expect(diffNext.items.map((item) => item.path)).toEqual(["src/other.ts"]);
    await expect(
      f.query("source.diff", { ...input, cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
  });

  it("scopes tree cursors by saved version, side, directory and review", async () => {
    const f = await fixture();
    const input = {
      ...f.input,
      side: "head" as const,
      directory: "src",
      limit: 1,
    };
    const first = await f.query("source.tree", input);
    expect(first.items.map((item) => item.path)).toEqual(["src/file.ts"]);
    const next = await f.query("source.tree", {
      ...input,
      cursor: first.nextCursor!,
    });
    expect(next.items.map((item) => item.path)).toEqual(["src/other.ts"]);
    const other = await f.create();
    for (const mismatch of [
      { reviewVersion: 0 },
      { side: "base" as const },
      { directory: undefined },
      { reviewId: other.review.id, reviewVersion: 0 },
    ])
      await expect(
        f.query("source.tree", {
          ...input,
          cursor: first.nextCursor!,
          ...mismatch,
        }),
      ).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
  });

  it("keeps historical pins readable after a new source revision and ignores working-copy edits", async () => {
    const f = await fixture();
    renameSync(
      path.join(f.repositoryPath, "src/file.ts"),
      path.join(f.repositoryPath, "src/renamed.ts"),
    );
    const nextHead = commit(f.repositoryPath, "Rename source");
    await f.command("review.revision.create", {
      reviewId: f.review.id,
      expectedReviewVersion: 1,
      change: { kind: "range", baseRef: f.base, headRef: nextHead },
    });
    writeFileSync(
      path.join(f.repositoryPath, "src/renamed.ts"),
      "uncommitted poison",
    );
    const read = (reviewVersion: number, file: string) =>
      f.query("source.read", {
        reviewId: f.review.id,
        reviewVersion,
        side: "head",
        file,
      });
    expect(await read(1, "src/file.ts")).toMatchObject({
      commit: f.head,
      text: "feature();\ntwo();\n",
    });
    expect(await read(2, "src/renamed.ts")).toMatchObject({
      commit: nextHead,
      text: "feature();\ntwo();\n",
    });
    await expect(read(1, "src/renamed.ts")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("rejects unsafe paths and unavailable source repositories without returning working-copy content", async () => {
    const f = await fixture();
    await expect(
      f.query("source.read", { ...f.input, side: "head", file: "../private" }),
    ).rejects.toThrow(/file/);
    renameSync(f.repositoryPath, path.join(f.directory, "offline"));
    await expect(
      f.query("source.read", { ...f.input, side: "head", file: "src/file.ts" }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
  });
});
