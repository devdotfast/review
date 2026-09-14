import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StoreClient } from "./store-client";
import { rememberTraceRepositoryTarget } from "./trace-repository-target";
import { listUploadReceipts, saveUploadReceipt } from "./trace-upload-receipts";
import { writeOwnUploadStatus } from "./trace-upload-status";

const origin = "https://app.dev.fast";

const storeId = "a".repeat(32);

const uploadId = "b".repeat(32);

const target = { origin, repositoryId: 123, storeId, name: "acme/app" };

const confirmedAt = "2026-09-14T10:00:00.000Z";

const sessionId = "my-upload-session";

describe("own upload status", () => {
  let cwd: string;
  let devHome: string;
  let output: string;
  let stdout: Writable;
  let calls: URL[];
  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "own-upload-status-"));
    devHome = path.join(cwd, "home");
    execFileSync("git", ["init", "--quiet"], { cwd });
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:acme/app.git"],
      { cwd },
    );
    output = "";
    calls = [];
    stdout = new Writable({
      write(chunk, _encoding, done) {
        output += String(chunk);
        done();
      },
    });
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  function client(reply: () => Response, token = "test-login") {
    return new StoreClient({
      origin,
      token,
      fetch: async (url) => {
        const parsed = new URL(String(url));
        calls.push(parsed);

        if (parsed.pathname.endsWith("/stores"))
          return Response.json({
            repositoryId: 123,
            storeId,
            displayName: "acme/app",
            status: "active",
            createdAt: confirmedAt,
          });

        return reply();
      },
    });
  }

  async function receipt(scope: string) {
    await rememberTraceRepositoryTarget({ cwd, target, devHome });
    await saveUploadReceipt({
      scope,
      target,
      devHome,
      sessionId,
      uploadId,
      confirmedAt,
      omitted: { subagents: ["agent-omitted"], commits: 1 },
    });
  }

  it("checks completion without consent or transcript requests and shows omissions", async () => {
    const service = client(() =>
      Response.json({
        storeId,
        uploads: [
          {
            sessionId,
            uploadId,
            createdAt: confirmedAt,
            completedAt: confirmedAt,
            status: "complete",
            current: true,
          },
          {
            sessionId,
            uploadId: "c".repeat(32),
            createdAt: confirmedAt,
            completedAt: confirmedAt,
            status: "complete",
            current: false,
          },
          {
            sessionId,
            uploadId: "d".repeat(32),
            createdAt: confirmedAt,
            completedAt: null,
            status: "pending",
            current: false,
          },
        ],
      }),
    );

    await receipt(service.receiptScope()!);
    expect(
      await writeOwnUploadStatus({
        cwd,
        devHome,
        origin,
        stdout,
        client: service,
        session: sessionId,
      }),
    ).toBe(0);
    expect(output).toContain("checked with the store");
    expect(output).toContain("Uploaded at");
    expect(output).toContain("Uploaded, later replaced");
    expect(output).toContain("Not completed");
    expect(output).toContain(
      "Omitted from this upload: 1 subagent file(s), 1 commit link(s)",
    );
    expect(calls.map((url) => url.pathname)).toEqual([
      "/api/trace/v1/stores",
      "/api/trace/v1/stores/123/uploads",
    ]);
    expect(calls[1]?.searchParams.get("session")).toBe(sessionId);
  });

  it("distinguishes no attempts from an unavailable or older server", async () => {
    expect(
      await writeOwnUploadStatus({
        cwd,
        devHome,
        origin,
        stdout,
        client: client(() => Response.json({ storeId, uploads: [] })),
      }),
    ).toBe(0);
    expect(output).toContain("No upload found for this account");
    output = "";

    const older = client(() =>
      Response.json(
        { error: { code: "not_found", message: "Unknown route" } },
        { status: 404 },
      ),
    );

    expect(
      await writeOwnUploadStatus({
        cwd,
        devHome,
        origin,
        stdout,
        client: older,
      }),
    ).toBe(1);
    expect(output).toContain("not checked");
    expect(output).not.toContain("No upload found");
  });

  it.each([403, 401, 410, 503])(
    "handles status %s without claiming success",
    async (status) => {
      const codes = {
        403: "forbidden",
        401: "unauthorized",
        410: "store_deleted",
        503: "internal",
      };

      const service = client(() =>
        Response.json(
          {
            error: {
              code: codes[status as keyof typeof codes],
              message: "Not available",
            },
          },
          { status },
        ),
      );

      await receipt(service.receiptScope()!);
      expect(
        await writeOwnUploadStatus({
          cwd,
          devHome,
          origin,
          stdout,
          client: service,
        }),
      ).toBe(1);
      expect(output).toContain("not checked");
      expect(
        output.includes(
          `Previously confirmed at ${confirmedAt}; current status unknown`,
        ),
      ).toBe(status === 503);
      expect(output.includes("Omitted from this upload")).toBe(status === 503);
    },
  );

  it("does not reuse receipts across logins or recreated stores", async () => {
    const service = client(() => {
      throw new Error("offline");
    });

    await receipt(service.receiptScope()!);

    const other = client(() => {
      throw new Error("offline");
    }, "another-login");

    await writeOwnUploadStatus({ cwd, devHome, origin, stdout, client: other });
    expect(output).not.toContain("Previously confirmed");
    expect(
      await listUploadReceipts({
        scope: service.receiptScope()!,
        target: { ...target, storeId: "c".repeat(32) },
        devHome,
      }),
    ).toEqual([]);
  });

  it("rejects invalid filters before contacting the store", async () => {
    expect(
      await writeOwnUploadStatus({
        cwd,
        devHome,
        origin,
        stdout,
        client: client(() => Response.json({})),
        limit: 0,
      }),
    ).toBe(1);
    expect(calls).toEqual([]);
  });
});
