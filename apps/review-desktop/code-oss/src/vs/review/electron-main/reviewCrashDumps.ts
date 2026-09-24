/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from "node:fs";
import * as path from "node:path";

export interface CrashDump {
  readonly path: string;
  readonly mtime: number;
  readonly bytes: number;
}

/** One app launch, so a dump written during it reports that launch's identity. */
export interface CrashDumpLaunch {
  readonly startedAt: number;
  readonly appSessionId: string;
  readonly appVersion: string;
  cliVersion?: string;
}

export interface CrashDumpLedger {
  uploaded: string[];
  /** When a crash was counted: by a live listener, or from its dump. */
  liveCrashesAt: number[];
  /** The most recent launches, oldest first. */
  launches: CrashDumpLaunch[];
}

const MAX_LAUNCHES = 10;

const MAX_DUMP_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const LIVE_CRASH_WINDOW_MS = 10_000;
/** The Worker refuses a gzip dump over this; retrying cannot help. */
const DUMP_TOO_LARGE = 413;
const LEDGER_FILE = "ledger.json";
/** Crashpad's completed-report folders on macOS/Linux and Windows. */
const DUMP_FOLDERS = ["completed", "reports", "pending"];

export function planCrashDumps(input: { dumps: CrashDump[]; ledger: CrashDumpLedger; now: number }): {
  report: Array<CrashDump & { covered: boolean }>;
  discard: CrashDump[];
} {
  const report: Array<CrashDump & { covered: boolean }> = [];
  const discard: CrashDump[] = [];
  for (const dump of input.dumps) {
    if (input.ledger.uploaded.includes(dump.path) || input.now - dump.mtime > MAX_DUMP_AGE_MS) {
      discard.push(dump);
      continue;
    }
    const covered = input.ledger.liveCrashesAt.some((at) => Math.abs(at - dump.mtime) <= LIVE_CRASH_WINDOW_MS);
    report.push({ ...dump, covered });
  }
  return { report, discard };
}

/** The launch a dump belongs to: the latest one that started before it was written. */
export function launchOfDump(launches: readonly CrashDumpLaunch[], mtime: number): CrashDumpLaunch | undefined {
  let match: CrashDumpLaunch | undefined;
  for (const launch of launches) {
    if (launch.startedAt <= mtime && (!match || launch.startedAt > match.startedAt)) match = launch;
  }
  return match;
}

export function listCrashDumps(dumpsDir: string): CrashDump[] {
  const dumps: CrashDump[] = [];
  for (const folder of DUMP_FOLDERS) {
    let entries: string[];
    try {
      entries = fs.readdirSync(path.join(dumpsDir, folder));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".dmp")) continue;
      const file = path.join(dumpsDir, folder, entry);
      try {
        const stat = fs.statSync(file);
        dumps.push({ path: file, mtime: Math.round(stat.mtimeMs), bytes: stat.size });
      } catch {
        // A dump Crashpad is still writing is picked up next launch.
      }
    }
  }
  return dumps;
}

function numbers(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === "number") : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function launches(value: unknown): CrashDumpLaunch[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: { startedAt?: unknown; appSessionId?: unknown; appVersion?: unknown; cliVersion?: unknown } | null) => {
    if (!entry || typeof entry.startedAt !== "number" || typeof entry.appSessionId !== "string" || typeof entry.appVersion !== "string") return [];
    const launch: CrashDumpLaunch = { startedAt: entry.startedAt, appSessionId: entry.appSessionId, appVersion: entry.appVersion };
    if (typeof entry.cliVersion === "string") launch.cliVersion = entry.cliVersion;
    return [launch];
  });
}

export function readLedger(dumpsDir: string): CrashDumpLedger {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dumpsDir, LEDGER_FILE), "utf8")) as { uploaded?: unknown; liveCrashesAt?: unknown; launches?: unknown };
    return { uploaded: strings(parsed.uploaded), liveCrashesAt: numbers(parsed.liveCrashesAt), launches: launches(parsed.launches) };
  } catch {
    return { uploaded: [], liveCrashesAt: [], launches: [] };
  }
}

export function writeLedger(dumpsDir: string, ledger: CrashDumpLedger): void {
  try {
    fs.mkdirSync(dumpsDir, { recursive: true });
    fs.writeFileSync(path.join(dumpsDir, LEDGER_FILE), JSON.stringify(ledger), "utf8");
  } catch {
    // Losing the ledger only means a dump may be reported twice.
  }
}

export interface ReviewCrashDumpsOptions {
  readonly dumpsDir: string;
  /** This launch; recorded at once, so a crash before the server is up still maps to it. */
  readonly launch: Omit<CrashDumpLaunch, "cliVersion">;
  readonly whenConnected: () => Promise<{ readonly url: string; readonly token: string; readonly cliVersion?: string }>;
  readonly isTelemetryEnabled: () => boolean;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly logError?: (message: string) => void;
}

/**
 * Hands the minidumps Crashpad wrote during earlier runs to the server, which
 * counts each one no live listener covered as a crash event and uploads it,
 * both stamped with the launch the dump came from. With telemetry off the
 * dumps are deleted and nothing leaves. A failed upload (the Worker
 * rate-limits per IP) is retried next launch until the dump is 7 days old.
 */
export class ReviewCrashDumps {
  private readonly ledger: CrashDumpLedger;
  private readonly launch: CrashDumpLaunch;

  constructor(private readonly options: ReviewCrashDumpsOptions) {
    this.ledger = readLedger(options.dumpsDir);
    this.launch = { ...options.launch };
    this.ledger.launches = [...this.ledger.launches.slice(-(MAX_LAUNCHES - 1)), this.launch];
    writeLedger(options.dumpsDir, this.ledger);
  }

  recordLiveCrash(at: number): void {
    this.ledger.liveCrashesAt = [...this.ledger.liveCrashesAt.slice(-50), at];
    writeLedger(this.options.dumpsDir, this.ledger);
  }

  async reconcile(): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    const plan = planCrashDumps({ dumps: listCrashDumps(this.options.dumpsDir), ledger: this.ledger, now });
    for (const dump of plan.discard) this.remove(dump.path);
    if (!this.options.isTelemetryEnabled()) {
      for (const dump of plan.report) this.remove(dump.path);
      this.ledger.uploaded = [];
      writeLedger(this.options.dumpsDir, this.ledger);
      return;
    }
    let connection: Awaited<ReturnType<ReviewCrashDumpsOptions["whenConnected"]>>;
    try {
      connection = await this.options.whenConnected();
    } catch (error) {
      this.options.logError?.(`[Review Desktop] crash dumps wait for the next launch: ${error}`);
      return;
    }
    if (connection.cliVersion && !this.launch.cliVersion) this.launch.cliVersion = connection.cliVersion;
    for (const dump of plan.report) {
      const result = await this.upload(connection, dump);
      // Counted now, so a retry after a failed upload does not count it again.
      if (result?.counted) this.ledger.liveCrashesAt.push(dump.mtime);
      if (result?.ok) this.ledger.uploaded = [...this.ledger.uploaded.slice(-200), dump.path];
      if (result?.ok || result?.status === DUMP_TOO_LARGE) this.remove(dump.path);
    }
    this.ledger.liveCrashesAt = this.ledger.liveCrashesAt.filter((at) => now - at <= MAX_DUMP_AGE_MS);
    writeLedger(this.options.dumpsDir, this.ledger);
  }

  private async upload(
    connection: { readonly url: string; readonly token: string },
    dump: CrashDump & { covered: boolean },
  ): Promise<{ ok: boolean; status: number; counted: boolean } | undefined> {
    const launch = launchOfDump(this.ledger.launches, dump.mtime);
    try {
      const response = await (this.options.fetchImpl ?? fetch)(`${connection.url}/crash-reports`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-review-token": connection.token },
        body: JSON.stringify({
          dump_path: dump.path,
          crashed_at: dump.mtime,
          covered: dump.covered,
          launch: launch && { app_session_id: launch.appSessionId, app_version: launch.appVersion, cli_version: launch.cliVersion },
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { counted?: unknown };
      return { ok: response.ok, status: response.status, counted: body.counted === true };
    } catch (error) {
      this.options.logError?.(`[Review Desktop] crash dump upload failed: ${error}`);
      return undefined;
    }
  }

  private remove(file: string): void {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Left for the next launch.
    }
  }
}
