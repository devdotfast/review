import path from "node:path";

import type { AgentTraceHookAgent } from "@dev.fast/trace-core";

// Task 22 writes the bodies of installSelf, uninstallSelf, and
// selfInstallStatus. The path helpers below are final: the program and its
// tests need them now, and they hold no install logic.

/** The command file the install writes under the user's home directory. */
export function shimPath(homeDir: string): string {
  return path.join(homeDir, ".local", "bin", "dev-traces");
}

/** The directory that holds every installed version. */
export function tracesDir(devHome: string): string {
  return path.join(devHome, "traces");
}

/** The link that points at the installed version in use. */
export function currentLink(devHome: string): string {
  return path.join(tracesDir(devHome), "current");
}

/** The entry file of the installed version in use. */
export function currentCliPath(devHome: string): string {
  return path.join(currentLink(devHome), "dist", "cli.js");
}

export interface InstallSelfInput {
  packageRoot: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  devHome: string;
  execPath: string;
  force: boolean;
}

export interface InstallSelfResult {
  version: string;
  installedRoot: string;
  copied: boolean;
  shimPath: string;
  output: string;
}

export interface UninstallSelfInput {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  devHome: string;
}

export interface UninstallSelfResult {
  removedShim: boolean;
  keptForeignShim: boolean;
  profiles: string[];
  hooksRemoved: AgentTraceHookAgent[];
  repositoriesDisabled: string[];
  output: string;
}

export interface SelfInstallStatusInput {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  devHome: string;
  ownCliPath: string;
  runningVersion: string;
}

export interface SelfInstallStatus {
  installed: boolean;
  installedVersion: string | null;
  currentPath: string;
  shim: { path: string; present: boolean; owned: boolean; onPath: boolean };
  runtimePath: string | null;
  lines: string[];
}

/** Copies the running package under the trace home and writes the shim. */
export async function installSelf(
  input: InstallSelfInput,
): Promise<InstallSelfResult> {
  throw new Error("not implemented: installSelf");
}

/** Removes the shim, the installed versions, and the hooks they own. */
export async function uninstallSelf(
  input: UninstallSelfInput,
): Promise<UninstallSelfResult> {
  throw new Error("not implemented: uninstallSelf");
}

/** Reports the installed version, the shim, and the runtime in use. */
export async function selfInstallStatus(
  input: SelfInstallStatusInput,
): Promise<SelfInstallStatus> {
  throw new Error("not implemented: selfInstallStatus");
}
