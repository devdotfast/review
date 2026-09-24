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

export interface CrashDumpLedger {
  uploaded: string[];
  /** When a crash was counted: by a live listener, or from its dump. */
  liveCrashesAt: number[];
}

const MAX_DUMP_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const LIVE_CRASH_WINDOW_MS = 10_000;
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

export function readLedger(dumpsDir: string): CrashDumpLedger {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dumpsDir, LEDGER_FILE), "utf8")) as { uploaded?: unknown; liveCrashesAt?: unknown };
    return { uploaded: strings(parsed.uploaded), liveCrashesAt: numbers(parsed.liveCrashesAt) };
  } catch {
    return { uploaded: [], liveCrashesAt: [] };
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
  readonly whenConnected: () => Promise<{ readonly url: string; readonly token: string }>;
  readonly isTelemetryEnabled: () => boolean;
  readonly capture: (name: string, properties: Record<string, string | number | boolean>) => void;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly logError?: (message: string) => void;
}

/**
 * Turns the minidumps Crashpad wrote during earlier runs into crash events and
 * uploads. A dump the live listeners already counted still uploads, but is not
 * counted twice. With telemetry off the dumps are deleted and nothing leaves.
 * The server makes the upload, so its opt-out check and envelope apply; a
 * failed upload (the Worker rate-limits per IP) is retried next launch until
 * the dump is 7 days old.
 */
export class ReviewCrashDumps {
  private readonly ledger: CrashDumpLedger;

  constructor(private readonly options: ReviewCrashDumpsOptions) {
    this.ledger = readLedger(options.dumpsDir);
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
    for (const dump of plan.report) {
      if (!dump.covered) {
        this.options.capture("crash", { process: "unknown", reason: "minidump", source: "minidump" });
        // Counted now, so a retry after a failed upload does not count it again.
        this.ledger.liveCrashesAt.push(dump.mtime);
      }
      if (await this.upload(dump)) {
        this.ledger.uploaded = [...this.ledger.uploaded.slice(-200), dump.path];
        this.remove(dump.path);
      }
    }
    this.ledger.liveCrashesAt = this.ledger.liveCrashesAt.filter((at) => now - at <= MAX_DUMP_AGE_MS);
    writeLedger(this.options.dumpsDir, this.ledger);
  }

  private async upload(dump: CrashDump & { covered: boolean }): Promise<boolean> {
    try {
      const connection = await this.options.whenConnected();
      const response = await (this.options.fetchImpl ?? fetch)(`${connection.url}/crash-reports`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-review-token": connection.token },
        body: JSON.stringify({ dump_path: dump.path, crashed_at: dump.mtime, covered: dump.covered }),
      });
      return response.ok;
    } catch (error) {
      this.options.logError?.(`[Review Desktop] crash dump upload failed: ${error}`);
      return false;
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
