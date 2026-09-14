import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { cliRuntimeInfo } from "./cli-runtime-info";
import { traceTargetKey } from "./trace-repository-target";
import {
  recordTraceSessionProvenance,
  requireTraceSessionProvenance,
} from "./trace-session-provenance";
import {
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

it("reads legacy failures without promising retry", async () => {
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
