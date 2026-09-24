import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { openLocalReviewStore } from "../review-api/local-data";
import { ReviewTelemetry } from "../review-telemetry";
import {
  type CrashReportRequest,
  reportCrashDump,
  uploadCrashDump,
} from "./crash-report";
import { createGlobalReviewServer } from "./desktop-server";

const SESSION_ID = "6f1c2f55-2a4b-4b8e-9a51-0c0e3b1d7a10";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "crash-"));
  dirs.push(dir);

  return dir;
}

async function writeDump(dir: string, name = "x.dmp"): Promise<string> {
  const dump = path.join(dir, name);
  await writeFile(dump, "MDMP-bytes");

  return dump;
}

function captureForm() {
  const forms: FormData[] = [];

  const fetchImpl: typeof fetch = async (_url, init) => {
    if (init?.body instanceof FormData) forms.push(init.body);

    return Response.json({ ok: true, report_id: "r" });
  };

  return { forms, fetchImpl };
}

describe("uploadCrashDump", () => {
  it("posts the gzip minidump with exactly the Worker's meta keys", async () => {
    const dump = await writeDump(await tempDir());
    const { fetchImpl, forms } = captureForm();

    const result = await uploadCrashDump({
      dumpPath: dump,
      crashedAt: 1_700_000_000_000,
      covered: false,
      distinctId: "install-1",
      envelope: {
        app_version: "0.0.35",
        cli_version: "0.0.35",
        version: "0.0.35",
        channel: "stable",
        environment: "production",
        surface: "desktop",
        platform: "darwin",
        arch: "arm64",
        os_version: "25.2.0",
        node_major: 22,
        ci: false,
        internal: false,
        app_session_id: SESSION_ID,
        $process_person_profile: false,
      },
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    const meta = JSON.parse(String(forms[0]?.get("meta")));
    const part = forms[0]?.get("dump");

    if (!(part instanceof File)) throw new Error("dump part missing");

    expect(meta).toEqual({
      schema_version: 1,
      distinct_id: "install-1",
      crashed_at: 1_700_000_000_000,
      covered: false,
      dump_bytes: part.size,
      dump_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      app_version: "0.0.35",
      cli_version: "0.0.35",
      channel: "stable",
      environment: "production",
      surface: "desktop",
      platform: "darwin",
      arch: "arm64",
      os_version: "25.2.0",
      node_major: 22,
      ci: false,
      internal: false,
      app_session_id: SESSION_ID,
    });
    expect(part.name).toBe("minidump.dmp.gz");
    expect(part.type).toBe("application/gzip");
    expect(gunzipSync(Buffer.from(await part.arrayBuffer())).toString()).toBe(
      "MDMP-bytes",
    );
  });

  it("omits an envelope value the Worker would reject instead of sending it", async () => {
    const dump = await writeDump(await tempDir());
    const { fetchImpl, forms } = captureForm();

    await uploadCrashDump({
      dumpPath: dump,
      crashedAt: 1,
      covered: true,
      distinctId: "install-1",
      envelope: {
        app_version: "0.0.35 (dirty build)",
        os_version: "x".repeat(65),
        platform: "plan9",
        arch: "sparc",
        channel: "nightly",
        app_session_id: "launch-1",
        node_major: 22,
      },
      fetchImpl,
    });

    const meta = JSON.parse(String(forms[0]?.get("meta")));

    expect(Object.keys(meta).sort()).toEqual([
      "covered",
      "crashed_at",
      "distinct_id",
      "dump_bytes",
      "dump_sha256",
      "node_major",
      "schema_version",
    ]);
  });

  it("refuses a dump larger than the cap without reading it", async () => {
    const dir = await tempDir();
    const dump = path.join(dir, "big.dmp");
    await writeFile(dump, Buffer.alloc(1024));

    const result = await uploadCrashDump({
      dumpPath: dump,
      crashedAt: 0,
      covered: true,
      distinctId: "i",
      envelope: {},
      maxDumpBytes: 512,
      fetchImpl: async () => {
        throw new Error("must not fetch");
      },
    });

    expect(result).toEqual({
      ok: false,
      status: 413,
      error: "Crash dump is too large.",
    });
  });

  it("passes the Worker's failure status through so the dump is kept", async () => {
    const dump = await writeDump(await tempDir());

    const result = await uploadCrashDump({
      dumpPath: dump,
      crashedAt: 0,
      covered: true,
      distinctId: "i",
      envelope: {},
      fetchImpl: async () => new Response("slow down", { status: 429 }),
    });

    expect(result).toEqual({
      ok: false,
      status: 429,
      error: "Crash report service failed.",
    });
  });
});

describe("reportCrashDump", () => {
  function telemetry(sends: boolean): Parameters<typeof reportCrashDump>[0] {
    return {
      sendsEvents: async () => sends,
      envelope: async () => ({ platform: "darwin" }),
      getInstallationId: async () => "install-1",
    };
  }

  it("uploads a dump inside the Review dump directory", async () => {
    const dumpsDir = await tempDir();
    await mkdir(path.join(dumpsDir, "completed"));
    const dump = await writeDump(path.join(dumpsDir, "completed"));
    const { fetchImpl, forms } = captureForm();

    const result = await reportCrashDump(
      telemetry(true),
      { dump_path: dump, crashed_at: 5, covered: false },
      dumpsDir,
      fetchImpl,
    );

    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(JSON.parse(String(forms[0]?.get("meta")))).toMatchObject({
      distinct_id: "install-1",
      platform: "darwin",
      crashed_at: 5,
    });
  });

  it("refuses any file outside the dump directory or without the .dmp suffix", async () => {
    const dumpsDir = await tempDir();
    const outside = await writeDump(await tempDir(), "secret.dmp");
    const notADump = await writeDump(dumpsDir, "ledger.json");
    await symlink(outside, path.join(dumpsDir, "link.dmp"));

    for (const dumpPath of [
      outside,
      notADump,
      path.join(dumpsDir, "link.dmp"),
      path.join(dumpsDir, "..", path.basename(outside)),
    ]) {
      const result = await reportCrashDump(
        telemetry(true),
        { dump_path: dumpPath, crashed_at: 5, covered: false },
        dumpsDir,
        async () => {
          throw new Error("must not fetch");
        },
      );

      expect(result.status).toBe(403);
    }

    const noDirectory = await reportCrashDump(
      telemetry(true),
      { dump_path: outside, crashed_at: 5, covered: false },
      undefined,
    );

    expect(noDirectory.status).toBe(403);
  });

  it("skips the upload when telemetry is off or only printed", async () => {
    const dumpsDir = await tempDir();
    const dump = await writeDump(dumpsDir);

    const result = await reportCrashDump(
      telemetry(false),
      { dump_path: dump, crashed_at: 5, covered: false },
      dumpsDir,
      async () => {
        throw new Error("must not fetch");
      },
    );

    expect(result).toEqual({
      status: 200,
      body: { ok: true, skipped: "telemetry_disabled" },
    });
  });
});

describe("POST /crash-reports", () => {
  it("rejects a malformed body and any file outside the dump directory", async () => {
    const home = await tempDir();
    const dumpsDir = path.join(home, "review-crashes");
    await mkdir(dumpsDir);
    const outside = await writeDump(home, "secret.dmp");
    const local = openLocalReviewStore(path.join(home, "review-api.db"));
    const token = "crash-report-test-token";

    const server = createGlobalReviewServer({
      reviewStore: local.store,
      reviewData: local.data,
      appPid: process.pid,
      packageRoot: home,
      toolingRoot: home,
      port: 0,
      token,
      discoveryPath: path.join(home, "review-desktop", "server.json"),
      telemetry: ReviewTelemetry.fromEnv({
        ...process.env,
        DEV_REVIEW_HOME: home,
      }),
      crashDumpsDir: dumpsDir,
    });

    const post = (body: Partial<CrashReportRequest>) =>
      fetch(`${server.url}/crash-reports`, {
        method: "POST",
        headers: {
          "x-review-token": token,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

    try {
      await server.listen();

      expect((await post({ dump_path: "" })).status).toBe(400);
      expect(
        (await post({ dump_path: outside, crashed_at: 1, covered: false }))
          .status,
      ).toBe(403);
    } finally {
      await server.close();
      await local.data.close();
      await local.store.close();
    }
  });
});
