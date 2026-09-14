import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { collectingWritable } from "./cli-output";
import { cliRuntimeInfo } from "./cli-runtime-info";
import { notifySkippedHostedCapture } from "./trace-capture-notice";
import { traceTargetKey } from "./trace-repository-target";
import {
  recordTraceSessionProvenance,
  requireTraceSessionProvenance,
} from "./trace-session-provenance";
import {
  clearTraceSyncFailure,
  describeTraceSyncFailure,
  listTraceSyncFailures,
  recordTraceSyncFailure,
  traceSyncStatusDir,
} from "./trace-sync-status";

const roots: string[] = [];

async function temporaryHome() {
  const home = await mkdtemp(
    path.join(os.tmpdir(), "review-trace-diagnostics-"),
  );

  roots.push(home);

  return home;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("deduplicates concurrent notices per origin and repository without writing consent", async () => {
  const devHome = await temporaryHome();
  const chunks: string[] = [];

  const output = {
    stream: collectingWritable(chunks),
    text: () => chunks.join(""),
  };

  const input = {
    origin: "https://app.dev.fast",
    repository: "acme/repo",
    devHome,
    stdout: output.stream,
  };

  await Promise.all([
    notifySkippedHostedCapture(input),
    notifySkippedHostedCapture({ ...input, repository: "Acme/Repo" }),
  ]);
  const files = await readdir(path.join(devHome, "trace", "notices"));
  expect(files).toHaveLength(1);
  expect(output.text().match(/Hosted trace capture/g)).toHaveLength(1);
  expect(
    (await stat(path.join(devHome, "trace", "notices", files[0]!))).mode &
      0o777,
  ).toBe(0o600);
  await expect(
    readFile(path.join(devHome, "trace", "config.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await notifySkippedHostedCapture({
    ...input,
    origin: "https://other.example",
  });
  expect(await readdir(path.join(devHome, "trace", "notices"))).toHaveLength(2);
});

it("keeps provenance decisions while distinguishing remediation", async () => {
  const devHome = await temporaryHome();
  const session = "session-provenance";

  const target = {
    origin: "https://app.dev.fast",
    repositoryId: 1,
    name: "acme/repo",
    storeId: "a".repeat(32),
  };

  await expect(
    requireTraceSessionProvenance(session, target, devHome),
  ).rejects.toMatchObject({ reason: "provenance_missing" });
  await recordTraceSessionProvenance({
    sessionId: session,
    identity: "unallowed:acme/repo",
    allowed: false,
    devHome,
  });
  await expect(
    requireTraceSessionProvenance(session, target, devHome),
  ).rejects.toMatchObject({ reason: "provenance_unapproved" });
  await recordTraceSessionProvenance({
    sessionId: session,
    identity: traceTargetKey(target),
    allowed: true,
    devHome,
  });
  await expect(
    requireTraceSessionProvenance(session, target, devHome),
  ).resolves.toBeUndefined();
  await recordTraceSessionProvenance({
    sessionId: session,
    identity: "unallowed:acme/other",
    allowed: false,
    devHome,
  });
  await expect(
    requireTraceSessionProvenance(session, target, devHome),
  ).rejects.toMatchObject({ reason: "provenance_mixed" });
});

it("reads legacy failures without promising retry and clears only the requested record", async () => {
  const devHome = await temporaryHome();
  await recordTraceSyncFailure({
    sessionId: "session-network",
    repository: "acme/repo",
    error: "network unavailable",
    devHome,
  });
  await recordTraceSyncFailure({
    sessionId: "session-unapproved",
    repository: "acme/repo",
    error: "no allowed hook",
    reason: "provenance_unapproved",
    devHome,
  });

  const legacy = {
    session: "session-legacy",
    repository: null,
    status: "failed",
    error: "old failure",
    at: new Date().toISOString(),
    retry: "review trace sync session-legacy",
  };

  await writeFile(
    path.join(traceSyncStatusDir(devHome), "session-legacy.json"),
    JSON.stringify(legacy),
  );
  const failures = await listTraceSyncFailures(devHome);
  expect(failures).toHaveLength(3);

  for (const failure of failures) {
    expect(describeTraceSyncFailure(failure).includes("Retry with")).toBe(
      failure.session === "session-network",
    );
  }

  await clearTraceSyncFailure("session-unapproved", devHome);
  await clearTraceSyncFailure("session-unapproved", devHome);
  expect(
    (await listTraceSyncFailures(devHome)).map((failure) => failure.session),
  ).toEqual(["session-legacy", "session-network"]);
  await expect(clearTraceSyncFailure("../escape", devHome)).rejects.toThrow(
    /Invalid/,
  );
});

it("reads build identity from the effective executable and reports unknown old builds", async () => {
  const directory = await temporaryHome();
  const requested = "/requested/dist/cli.js";
  const effective = path.join(directory, "cli.js");
  expect(cliRuntimeInfo(requested, effective)).toMatchObject({
    delegated: true,
    commit: null,
    version: null,
  });
  await writeFile(
    path.join(directory, "build-info.json"),
    JSON.stringify({
      version: "1.2.3",
      commit: "abc",
      dirty: true,
      builtAt: "2026-09-13T00:00:00Z",
    }),
  );
  expect(cliRuntimeInfo(requested, effective)).toMatchObject({
    requestedPath: requested,
    effectivePath: effective,
    version: "1.2.3",
    commit: "abc",
    dirty: true,
  });
});
