/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Emitter } from "../../base/common/event.js";
import { toDisposable } from "../../base/common/lifecycle.js";
import {
  DARWIN_UPDATE_ATTEMPT_STORAGE_KEY,
  DARWIN_UPDATE_OUTCOME_STORAGE_KEY,
} from "../../platform/update/common/darwinUpdateRecovery.js";
import {
  State,
  type IUpdateService,
  type State as UpdateState,
  UpdateType,
} from "../../platform/update/common/update.js";
import {
  StorageScope,
  type IStorageValueChangeEvent,
} from "../../platform/storage/common/storage.js";
import type { IApplicationStorageMainService } from "../../platform/storage/electron-main/storageMainService.js";
import type { ReviewMainErrorTelemetry } from "./reviewMainErrorTelemetry.js";
import {
  extractDarwinShipItFailureMessage,
  readDarwinShipItFailure,
  ReviewUpdateTelemetry,
} from "./reviewUpdateTelemetry.js";

const attempt = {
  sourceCommit: "source",
  targetCommit: "target",
  productVersion: "0.0.27",
  attemptedAt: 100,
  attemptId: "12345678-1234-1234-1234-123456789abc",
  shipItLogOffset: 4096,
};

test("extracts only the last concise ShipIt NSError summary", () => {
  const log = [
    'Installation error: Error Domain=NSPOSIXErrorDomain Code=13 "Permission denied" UserInfo={private=/Users/alice/repo}',
    "retrying",
    'Installation error: Error Domain=SQRLInstallerErrorDomain Code=-1 "Failed to copy bundle file:///Users/alice/Review.app to directory file:///Applications" UserInfo={private=secret}',
  ].join("\n");
  const message = extractDarwinShipItFailureMessage(log);
  assert.equal(
    message,
    'Error Domain=SQRLInstallerErrorDomain Code=-1 "Failed to copy bundle file:///Users/alice/Review.app to directory file:///Applications"',
  );
  assert.equal(message?.includes("UserInfo"), false);
  assert.equal(message?.includes("private=secret"), false);
});

test("uses the bounded ShipIt retry summary when NSError parsing fails", () => {
  assert.equal(
    extractDarwinShipItFailureMessage(
      "details\nToo many attempts to install, aborting update\n",
    ),
    "Too many attempts to install, aborting update",
  );
});

test("reads only ShipIt output appended after the matching attempt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "review-shipit-"));
  const path = join(directory, "ShipIt_stderr.log");
  try {
    const oldError =
      'Installation error: Error Domain=OldDomain Code=1 "Old failure"\n';
    await writeFile(path, oldError, "utf8");
    await appendFile(
      path,
      'Installation error: Error Domain=NewDomain Code=13 "Permission denied" UserInfo={private=secret}\n',
      "utf8",
    );
    assert.deepEqual(await readDarwinShipItFailure(path, oldError.length), {
      message: 'Error Domain=NewDomain Code=13 "Permission denied"',
      source: "shipit",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports staged, immediate failure, and terminal update events", async () => {
  const harness = createHarness();
  const telemetry = new ReviewUpdateTelemetry(harness.options);
  await turn();

  harness.storage.storeValue(
    DARWIN_UPDATE_ATTEMPT_STORAGE_KEY,
    JSON.stringify(attempt),
  );
  harness.update.setState(
    State.Ready(
      { version: attempt.targetCommit, productVersion: attempt.productVersion },
      false,
      false,
    ),
  );
  harness.update.setState(
    State.Ready(
      { version: attempt.targetCommit, productVersion: attempt.productVersion },
      false,
      false,
    ),
  );

  harness.update.setState(State.CheckingForUpdates(false));
  harness.update.setState(
    State.Idle(UpdateType.Archive, "Feed unavailable", undefined, "request"),
  );

  harness.storage.storeValue(
    DARWIN_UPDATE_OUTCOME_STORAGE_KEY,
    JSON.stringify({ kind: "applied", attempt, resolvedAt: 600 }),
  );
  await turn();

  assert.deepEqual(
    harness.events.map((event) => event.name),
    ["update_started", "update_failed", "update_completed"],
  );
  assert.deepEqual(harness.events[1], {
    name: "update_failed",
    properties: { phase: "check", message_source: "request" },
    error: {
      name: "UpdateCheckError",
      message: "Feed unavailable",
      stack: "Update lifecycle telemetry",
    },
  });
  assert.deepEqual(harness.events[2].properties, {
    update_attempt_id: attempt.attemptId,
    target_version: attempt.productVersion,
    duration_ms: 500,
  });
  assert.equal(
    harness.storage.getValue(DARWIN_UPDATE_OUTCOME_STORAGE_KEY),
    undefined,
  );
  telemetry.dispose();
});

test("reports an install failure with the matched ShipIt message", async () => {
  const harness = createHarness({
    outcome: { kind: "failed", attempt, resolvedAt: 700 },
    readInstallFailure: async () => ({
      message: 'Error Domain=NSPOSIXErrorDomain Code=13 "Permission denied"',
      source: "shipit",
    }),
  });
  const telemetry = new ReviewUpdateTelemetry(harness.options);
  await turn();

  assert.deepEqual(harness.events, [
    {
      name: "update_failed",
      properties: {
        update_attempt_id: attempt.attemptId,
        target_version: attempt.productVersion,
        duration_ms: 600,
        phase: "install",
        message_source: "shipit",
      },
      error: {
        name: "UpdateInstallError",
        message: 'Error Domain=NSPOSIXErrorDomain Code=13 "Permission denied"',
        stack: "Update lifecycle telemetry",
      },
    },
  ]);
  telemetry.dispose();
});

test("consumes disabled lifecycle records without reporting them later", async () => {
  let enabled = false;
  const harness = createHarness({
    enabled: () => enabled,
    outcome: { kind: "applied", attempt, resolvedAt: 600 },
  });
  const telemetry = new ReviewUpdateTelemetry(harness.options);
  await turn();
  assert.deepEqual(harness.events, []);
  assert.equal(
    harness.storage.getValue(DARWIN_UPDATE_OUTCOME_STORAGE_KEY),
    undefined,
  );

  harness.storage.storeValue(
    DARWIN_UPDATE_ATTEMPT_STORAGE_KEY,
    JSON.stringify(attempt),
  );
  harness.update.setState(
    State.Ready(
      { version: attempt.targetCommit, productVersion: attempt.productVersion },
      false,
      false,
    ),
  );
  assert.deepEqual(harness.events, []);

  enabled = true;
  harness.update.setState(
    State.Ready(
      { version: attempt.targetCommit, productVersion: attempt.productVersion },
      false,
      false,
    ),
  );
  assert.deepEqual(harness.events, []);
  telemetry.dispose();
});

function createHarness(options?: {
  readonly enabled?: () => boolean;
  readonly outcome?: unknown;
  readonly readInstallFailure?: () => Promise<{
    message: string;
    source: "shipit";
  }>;
}) {
  const storage = new FakeStorage();
  if (options?.outcome) {
    storage.storeValue(
      DARWIN_UPDATE_OUTCOME_STORAGE_KEY,
      JSON.stringify(options.outcome),
    );
  }
  const update = new FakeUpdateService();
  const events: Array<{
    name: string;
    properties: Readonly<Record<string, string | number | boolean>>;
    error?: unknown;
  }> = [];
  const telemetry = {
    capture(name: string, properties: Record<string, string | number | boolean>, error?: unknown) {
      events.push({ name, properties, error });
    },
  } as unknown as ReviewMainErrorTelemetry;
  return {
    storage,
    update,
    events,
    options: {
      updateService: update as unknown as IUpdateService,
      storageService: storage as unknown as IApplicationStorageMainService,
      telemetry,
      isTelemetryEnabled: options?.enabled ?? (() => true),
      shipItLogPath: "/tmp/ShipIt_stderr.log",
      readInstallFailure: options?.readInstallFailure,
    },
  };
}

class FakeUpdateService {
  private readonly emitter = new Emitter<UpdateState>();
  readonly onStateChange = this.emitter.event;
  state: UpdateState = State.Idle(UpdateType.Archive);

  setState(state: UpdateState): void {
    this.state = state;
    this.emitter.fire(this.state);
  }
}

class FakeStorage {
  readonly whenReady = Promise.resolve();
  private readonly values = new Map<string, string>();
  private readonly emitters = new Map<string, Emitter<IStorageValueChangeEvent>>();

  getValue(key: string): string | undefined {
    return this.values.get(key);
  }

  storeValue(key: string, value: string): void {
    this.values.set(key, value);
    this.fire(key);
  }

  get(key: string): string | undefined {
    return this.values.get(key);
  }

  store(key: string, value: string): void {
    this.storeValue(key, value);
  }

  remove(key: string): void {
    this.values.delete(key);
    this.fire(key);
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  onDidChangeValue(_scope: StorageScope, key: string | undefined) {
    if (!key) return () => toDisposable(() => undefined);
    let emitter = this.emitters.get(key);
    if (!emitter) {
      emitter = new Emitter<IStorageValueChangeEvent>();
      this.emitters.set(key, emitter);
    }
    return emitter.event;
  }

  private fire(key: string): void {
    this.emitters.get(key)?.fire({
      key,
      scope: StorageScope.APPLICATION,
      target: undefined,
      external: false,
    });
  }
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
