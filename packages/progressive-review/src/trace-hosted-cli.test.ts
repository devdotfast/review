import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearTraceEnvCache } from "./review-agent-traces";
import { StoreClient } from "./store-client";
import { runReviewTraceDeny, writeHostedTraceStatus } from "./trace-hosted-cli";
import { rememberTraceRepositoryTarget } from "./trace-repository-target";
import { allowTraceRepository, readTraceUserConfig } from "./trace-user-config";

const ORIGIN = "https://app.dev.fast";
const STORE_ID = "0123456789abcdef0123456789abcdef";

interface CollectedOutput {
  stream: Writable;
  text: () => string;
}

function collect(): CollectedOutput {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += String(chunk);
      callback();
    },
  });
  return { stream, text: () => text };
}

describe("hosted trace commands", () => {
  let home: string;
  let repo: string;
  let devHome: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "trace-hosted-cli-"));
    repo = path.join(home, "repo");
    devHome = path.join(home, ".dev");
    env = { DEV_REVIEW_HOME: devHome };
    execFileSync("git", ["init", "--quiet", repo]);
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:acme/app.git"],
      { cwd: repo },
    );
    clearTraceEnvCache();
  });

  afterEach(() => {
    clearTraceEnvCache();
    rmSync(home, { recursive: true, force: true });
  });

  function client(handler: (url: string, init?: RequestInit) => Response) {
    return new StoreClient({
      origin: ORIGIN,
      token: "token",
      fetch: vi.fn<typeof fetch>(async (input, init) =>
        handler(String(input), init),
      ),
    });
  }

  it("deletes the store on request after withdrawing consent", async () => {
    await allowTraceRepository(
      { repositoryId: 7, name: "acme/app", origin: ORIGIN },
      devHome,
    );
    await rememberTraceRepositoryTarget({
      cwd: repo,
      target: {
        origin: ORIGIN,
        repositoryId: 7,
        storeId: STORE_ID,
        name: "acme/app",
      },
      checkout: "acme/app",
      devHome,
    });
    const calls: string[] = [];
    const out = collect();
    const code = await runReviewTraceDeny({
      cwd: repo,
      env,
      homeDir: home,
      deleteStore: true,
      client: client((url, init) => {
        calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
        return Response.json({
          repositoryId: 7,
          storeId: STORE_ID,
          status: "deleting",
          deletedAt: "2026-09-09T00:00:00.000Z",
        });
      }),
      stdout: out.stream,
      stderr: out.stream,
    });
    expect(code).toBe(0);
    expect(calls).toEqual(["DELETE /api/trace/v1/stores/7"]);
    expect((await readTraceUserConfig(devHome)).repositories).toEqual([]);
    expect(out.text()).toContain("deletion requested");
  });

  it("prints the stored bytes of this repository's store", async () => {
    await allowTraceRepository(
      { repositoryId: 7, name: "acme/app", origin: ORIGIN },
      devHome,
    );
    const out = collect();
    await writeHostedTraceStatus({
      cwd: repo,
      env,
      homeDir: home,
      origin: ORIGIN,
      stdout: out.stream,
      client: client(() =>
        Response.json({
          repositoryId: 7,
          storeId: STORE_ID,
          displayName: "acme/app",
          status: "active",
          createdAt: "2026-09-01T00:00:00.000Z",
          bytesStored: 2048,
        }),
      ),
    });
    expect(out.text()).toContain("Stored bytes: 2048");
  });
});
