import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CommandInvocation = {
  command: string;
  args: string[];
};

const failingRevisions = new Set([
  "origin/main",
  "refs/dev-fast/reviews/pr-123/head",
]);
const commandInvocations: CommandInvocation[] = [];

function mockCommit(revision: string): string {
  return createHash("sha1").update(revision).digest("hex");
}

type ExecFileCallback = (
  error: unknown,
  result?: { stdout: string; stderr: string },
) => void;

const mockedExecFile =
  vi.fn<
    (
      command: unknown,
      args?: unknown,
      options?: unknown,
      callback?: ExecFileCallback,
    ) => unknown
  >();
const mockedExecFileSync =
  vi.fn<(command: unknown, args?: unknown) => string>();

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  return {
    ...actual,
    execFile: mockedExecFile,
    execFileSync: mockedExecFileSync,
  };
});

function commandOutputForMock(command: string, args: string[]): string {
  if (command === "jj" && args[0] === "-R" && args[2] === "root") {
    return args[1];
  }

  if (command === "jj" && args.includes("log") && args.includes("-T")) {
    const revision = args[args.indexOf("-r") + 1] ?? "";
    if (failingRevisions.has(revision)) {
      throw new Error(`jj could not resolve ${revision}`);
    }
    return mockCommit(revision);
  }

  if (command === "git" && args[0] === "-C" && args[2] === "rev-parse") {
    if (args[3] === "--show-toplevel") return args[1];
    if (args[3] === "--verify") {
      const revisionWithMarker = args[4] ?? "";
      const revision = revisionWithMarker.replace(/\^\{commit\}$/, "");
      if (failingRevisions.has(revision)) {
        throw new Error(`git could not resolve ${revision}`);
      }
      return mockCommit(revision);
    }
  }

  throw new Error(`Unexpected command in mock: ${command} ${args.join(" ")}`);
}

function countJjLogInvocations(rootPath: string, revision: string): number {
  return commandInvocations.filter((invocation) => {
    if (invocation.command !== "jj") return false;
    if (invocation.args[0] !== "-R" || invocation.args[1] !== rootPath) {
      return false;
    }
    if (!invocation.args.includes("log") || !invocation.args.includes("-T")) {
      return false;
    }
    const revisionIndex = invocation.args.indexOf("-r");
    return (
      revisionIndex >= 0 && invocation.args[revisionIndex + 1] === revision
    );
  }).length;
}

beforeEach(() => {
  commandInvocations.length = 0;
  mockedExecFile.mockReset();
  mockedExecFileSync.mockReset();

  mockedExecFile.mockImplementation((command, args, _options, cb) => {
    const stringCommand = `${command}`;
    const stringArgs = [...(args as string[])];
    commandInvocations.push({ command: stringCommand, args: stringArgs });

    try {
      const output = commandOutputForMock(stringCommand, stringArgs);
      if (typeof cb === "function") {
        cb(null, { stdout: output, stderr: "" });
      } else if (typeof _options === "function") {
        (
          _options as (error: unknown, stdout?: string, stderr?: string) => void
        )(null, output, "");
      }
    } catch (error) {
      if (typeof cb === "function") {
        cb(error as Error);
      } else if (typeof _options === "function") {
        (
          _options as (error: unknown, stdout?: string, stderr?: string) => void
        )(error);
      }
    }

    return {} as never;
  });

  mockedExecFileSync.mockImplementation((command, args) => {
    const stringCommand = `${command}`;
    const stringArgs = [...(args as string[])];
    commandInvocations.push({ command: stringCommand, args: stringArgs });
    return commandOutputForMock(stringCommand, stringArgs);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

async function loadLocalVcs() {
  vi.resetModules();
  return await import("./index");
}

describe("local vcs command caching", () => {
  it("deduplicates identical async resolution queries", async () => {
    vi.useFakeTimers();
    const { currentHead } = await loadLocalVcs();
    const rootPath = "/tmp/local-vcs-cache-async";

    const [first, second] = await Promise.all([
      currentHead(rootPath),
      currentHead(rootPath),
    ]);

    expect(mockedExecFile).toHaveBeenCalled();
    expect(first).toEqual({ commit: mockCommit("@") });
    expect(second).toEqual({ commit: mockCommit("@") });
    expect(commandInvocations).toHaveLength(2);

    const third = await currentHead(rootPath);
    expect(third).toEqual({ commit: mockCommit("@") });
    expect(commandInvocations).toHaveLength(2);
  });

  it("reruns async cached resolution queries after TTL", async () => {
    vi.useFakeTimers();
    const { resolveRevision } = await loadLocalVcs();
    const rootPath = "/tmp/local-vcs-cache-ttl";

    const first = await resolveRevision(rootPath, "abc");
    const second = await resolveRevision(rootPath, "abc");

    expect(first).toMatchObject({ commit: mockCommit("abc") });
    expect(second).toMatchObject({ commit: mockCommit("abc") });
    expect(commandInvocations).toHaveLength(2);

    vi.advanceTimersByTime(5_000);
    const third = await resolveRevision(rootPath, "abc");

    expect(third).toMatchObject({ commit: mockCommit("abc") });
    expect(commandInvocations).toHaveLength(4);
  });

  it("deduplicates identical failing async resolution queries", async () => {
    vi.useFakeTimers();
    const { resolveRevision } = await loadLocalVcs();
    const rootPath = "/tmp/local-vcs-cache-fail-async";

    const first = await resolveRevision(rootPath, "origin/main");
    const second = await resolveRevision(rootPath, "origin/main");

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(countJjLogInvocations(rootPath, "origin/main")).toBe(1);

    const third = await resolveRevision(rootPath, "origin/main");
    expect(third).toBeNull();
    expect(countJjLogInvocations(rootPath, "origin/main")).toBe(1);
  });

  it("reruns failing async cached resolution queries after TTL", async () => {
    vi.useFakeTimers();
    const { resolveRevision } = await loadLocalVcs();
    const rootPath = "/tmp/local-vcs-cache-fail-async-ttl";

    const first = await resolveRevision(
      rootPath,
      "refs/dev-fast/reviews/pr-123/head",
    );
    const second = await resolveRevision(
      rootPath,
      "refs/dev-fast/reviews/pr-123/head",
    );

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(
      countJjLogInvocations(rootPath, "refs/dev-fast/reviews/pr-123/head"),
    ).toBe(1);

    vi.advanceTimersByTime(5_000);
    const third = await resolveRevision(
      rootPath,
      "refs/dev-fast/reviews/pr-123/head",
    );

    expect(third).toBeNull();
    expect(
      countJjLogInvocations(rootPath, "refs/dev-fast/reviews/pr-123/head"),
    ).toBe(2);
  });

  it("reruns sync cached resolution queries after TTL", async () => {
    vi.useFakeTimers();
    const { resolveRevisionSync } = await loadLocalVcs();
    const rootPath = "/tmp/local-vcs-cache-sync-ttl";

    const first = resolveRevisionSync(rootPath, "abc");
    const second = resolveRevisionSync(rootPath, "abc");

    expect(first).toMatchObject({ commit: mockCommit("abc") });
    expect(second).toMatchObject({ commit: mockCommit("abc") });
    expect(commandInvocations).toHaveLength(2);

    vi.advanceTimersByTime(5_000);
    const third = resolveRevisionSync(rootPath, "abc");

    expect(third).toMatchObject({ commit: mockCommit("abc") });
    expect(commandInvocations).toHaveLength(4);
  });

  it("reruns failing sync cached resolution queries after TTL", async () => {
    vi.useFakeTimers();
    const { resolveRevisionSync } = await loadLocalVcs();
    const rootPath = "/tmp/local-vcs-cache-fail-sync-ttl";

    const first = resolveRevisionSync(rootPath, "origin/main");
    const second = resolveRevisionSync(rootPath, "origin/main");

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(countJjLogInvocations(rootPath, "origin/main")).toBe(1);

    vi.advanceTimersByTime(5_000);
    const third = resolveRevisionSync(rootPath, "origin/main");

    expect(third).toBeNull();
    expect(countJjLogInvocations(rootPath, "origin/main")).toBe(2);
  });

  it("keeps cache entries separate for different roots and args", async () => {
    const rootA = "/tmp/local-vcs-cache-root-a";
    const rootB = "/tmp/local-vcs-cache-root-b";

    const { currentHeadSync, resolveRevisionSync } = await loadLocalVcs();
    const rootAHead = currentHeadSync(rootA);
    const rootBHead = currentHeadSync(rootB);
    const rootABase = resolveRevisionSync(rootA, "base");
    const rootAHeadAgain = resolveRevisionSync(rootA, "HEAD");
    const rootAFeature = resolveRevisionSync(rootA, "feature");
    const rootAFeatureAgain = resolveRevisionSync(rootA, "feature");

    expect(rootAHead).toEqual({ commit: mockCommit("@") });
    expect(rootBHead).toEqual({ commit: mockCommit("@") });
    expect(rootABase).toEqual({ commit: mockCommit("base") });
    expect(rootAHeadAgain).toEqual({ commit: mockCommit("HEAD") });
    expect(rootAFeature).toEqual({ commit: mockCommit("feature") });
    expect(rootAFeatureAgain).toEqual({ commit: mockCommit("feature") });

    expect(commandInvocations).toHaveLength(7);
  });
});
