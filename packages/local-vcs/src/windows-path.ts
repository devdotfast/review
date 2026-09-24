import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * A Windows process keeps the PATH it launched with, so Git installed while
 * Whiteboard runs is only in the saved system and user PATH. Merge those (and
 * Git for Windows' usual location) into this process. Returns whether PATH
 * gained any entries.
 */
export function refreshWindowsPath(): boolean {
  if (process.platform !== "win32") return false;

  const current = (process.env.PATH ?? "").split(";").filter(Boolean);
  const known = new Set(current.map(normalizeEntry));
  const added: string[] = [];

  const candidates = [
    ...savedPath(
      "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
    ),
    ...savedPath("HKCU\\Environment"),
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "cmd"),
  ];

  for (const entry of candidates) {
    const key = normalizeEntry(entry);

    if (known.has(key) || !fs.existsSync(entry)) continue;
    known.add(key);
    added.push(entry);
  }

  if (added.length === 0) return false;
  process.env.PATH = [...current, ...added].join(";");

  return true;
}

function savedPath(key: string): string[] {
  let output: string;

  try {
    output = execFileSync("reg.exe", ["query", key, "/v", "Path"], {
      encoding: "utf8",
      windowsHide: true,
    });
  } catch {
    return [];
  }

  const value = output.match(/^\s*Path\s+REG_\w+\s*(.*)$/im)?.[1] ?? "";

  return value
    .split(";")
    .map((entry) =>
      entry
        .trim()
        .replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole),
    )
    .filter(Boolean);
}

function normalizeEntry(entry: string): string {
  return path.win32.resolve(entry).toLowerCase();
}
