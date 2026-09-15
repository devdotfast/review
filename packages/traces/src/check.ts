import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";
import { promisify } from "node:util";

import {
  type AgentTraceHookAgent,
  type CliInputStream,
  type CliJsonOutput,
  StoreApiError,
  StoreClient,
  type TraceScope,
  agentTraceHookPath,
  describeTraceHookOwners,
  emitJsonEvent,
  errorMessage,
  findTraceRepository,
  gitCommonDirectory,
  hostedCaptureEnabled,
  hostedOrigin,
  humanStream,
  inferRepoFromGit,
  listTraceSyncFailures,
  readActiveTraceSessions,
  readStoreAuth,
  readTraceConfigFile,
  readTraceUserConfig,
  renderTraceCommand,
  selectTraceStorage,
  traceRepoName,
  traceRepositoryStatus,
} from "@dev.fast/trace-core";
import type { StoreResponse } from "@dev.fast/trace-protocol";

import { NODE_FLOOR_MAJOR, supportedNodeRuntime } from "./node-floor.js";
import { selfInstallStatus, shimPath } from "./self-install.js";

const exec = promisify(execFile);

/** The harnesses whose hooks this package owns, in report order. */
const HOOK_AGENTS: AgentTraceHookAgent[] = [
  "claude",
  "codex",
  "opencode",
  "pi",
];

const INSTALL_FIX = "npx @dev.fast/traces install";

const RUNTIME_FIX = `Install Node ${NODE_FLOOR_MAJOR} or newer, then rerun ${INSTALL_FIX}`;

const PATH_FIX = "Add ~/.local/bin to PATH (open a new shell after allow)";

const ALLOW_FIX = "dev-traces allow .";

/** The sync failures one activity line names before it counts the rest. */
const MAX_REPORTED_FAILURES = 3;

export interface TraceCheckResult {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface RunTracesCheckInput {
  scope: TraceScope;
  cwd: string;
  ownCliPath: string;
  runningVersion: string;
  json?: boolean;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: CliInputStream;
  client?: StoreClient;
}

async function executable(filePath: string): Promise<boolean> {
  return access(filePath, constants.X_OK).then(
    () => true,
    () => false,
  );
}

async function present(filePath: string): Promise<boolean> {
  return access(filePath, constants.F_OK).then(
    () => true,
    () => false,
  );
}

/**
 * The Node the shim runs. The shim prefers an executable `DEV_TRACES_NODE`,
 * then the runtime the install baked in. This run's own Node answers for a
 * machine that never installed.
 */
export async function resolveShimRuntime(
  env: NodeJS.ProcessEnv,
  bakedPath: string | null,
): Promise<string> {
  const override = env.DEV_TRACES_NODE;

  if (override && (await executable(override))) return override;

  return bakedPath ?? process.execPath;
}

/** The Node version one runtime reports, or null when it does not run. */
async function runtimeVersion(
  runtime: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  try {
    const { stdout } = await exec(runtime, ["-p", "process.versions.node"], {
      env,
    });

    return stdout.trim();
  } catch {
    return null;
  }
}

/** The agent sessions this checkout still marks active. */
async function pendingSessionCount(cwd: string): Promise<number> {
  const commonDir = await gitCommonDirectory(cwd);

  if (!commonDir) return 0;

  const sessions = await readActiveTraceSessions(
    path.join(commonDir, "agent-session"),
  );

  return sessions.size;
}

/** The library takes a node stream; this input names the wider interface. */
function nodeWritable(stream: NodeJS.WritableStream): Writable {
  // SAFETY: every caller passes a node Writable, which satisfies the wider
  // NodeJS.WritableStream the input declares.
  return stream as Writable;
}

function ok(name: string, detail: string): TraceCheckResult {
  return { name, ok: true, detail };
}

function fail(name: string, detail: string, fix?: string): TraceCheckResult {
  return fix ? { name, ok: false, detail, fix } : { name, ok: false, detail };
}

/** Checks that this machine captures and publishes traces for one repository. */
export async function runTracesCheck(
  input: RunTracesCheckInput,
): Promise<number> {
  const scope = input.scope;
  const checks: TraceCheckResult[] = [];
  const shim = shimPath(scope.homeDir);

  // 1. The runtime the shim hands every hook.
  const install = await selfInstallStatus({
    homeDir: scope.homeDir,
    env: scope.env,
    devHome: scope.devHome,
    ownCliPath: input.ownCliPath,
    runningVersion: input.runningVersion,
  });

  const runtime = await resolveShimRuntime(scope.env, install.runtimePath);
  const version = await runtimeVersion(runtime, scope.env);

  checks.push(
    version && supportedNodeRuntime(version)
      ? ok("runtime", `${runtime} runs Node ${version}`)
      : fail(
          "runtime",
          version
            ? `${runtime} runs Node ${version}; dev-traces needs Node ${NODE_FLOOR_MAJOR} or newer`
            : `${runtime} did not run`,
          RUNTIME_FIX,
        ),
  );

  // 2. The installed copy and the command file that finds it.
  if (!install.installed) {
    checks.push(
      fail(
        "install",
        `not installed (running from ${input.ownCliPath})`,
        INSTALL_FIX,
      ),
    );
  } else if (install.installedVersion !== input.runningVersion) {
    checks.push(
      fail(
        "install",
        `installed ${install.installedVersion}, running ${input.runningVersion}`,
        INSTALL_FIX,
      ),
    );
  } else if (!install.shim.present) {
    checks.push(fail("install", `${shim} is absent`, INSTALL_FIX));
  } else if (!install.shim.owned) {
    checks.push(
      fail(
        "install",
        `${shim} is not managed by @dev.fast/traces`,
        INSTALL_FIX,
      ),
    );
  } else if (!install.shim.onPath) {
    checks.push(
      fail("install", `${path.dirname(shim)} is not on PATH`, PATH_FIX),
    );
  } else {
    checks.push(
      ok(
        "install",
        `dev-traces ${install.installedVersion} at ${install.currentPath}; ${shim} on PATH`,
      ),
    );
  }

  // 3. The login for the selected store.
  const selection = selectTraceStorage(scope);

  const origin =
    selection.hosted?.origin ?? hostedOrigin(readTraceConfigFile(scope).config);

  const auth = await readStoreAuth(scope.env);
  const loginFix = `dev-traces login --origin ${origin}`;
  let client: StoreClient | null = null;

  if (!auth) {
    checks.push(fail("login", `no login for ${origin}`, loginFix));
  } else if (auth.origin !== origin) {
    checks.push(
      fail(
        "login",
        `logged in to ${auth.origin}, but the selected store is ${origin}`,
        loginFix,
      ),
    );
  } else {
    client =
      input.client ??
      new StoreClient({ origin: auth.origin, token: auth.token });

    try {
      const session = await client.session();
      checks.push(ok("login", `${session.user.name} at ${origin}`));
    } catch (error) {
      const expired =
        error instanceof StoreApiError && error.code === "unauthorized";

      checks.push(
        expired
          ? fail("login", `the login for ${origin} expired`, loginFix)
          : fail("login", `Could not reach ${origin}: ${errorMessage(error)}`),
      );
      client = null;
    }
  }

  // 4. The repository and its store.
  let repository: string | null = null;
  let store: StoreResponse | null = null;

  try {
    repository = traceRepoName(await inferRepoFromGit(input.cwd));
  } catch (error) {
    checks.push(
      fail(
        "repository",
        errorMessage(error),
        "Run dev-traces check inside a GitHub checkout",
      ),
    );
  }

  if (repository && !client)
    checks.push(fail("repository", "skipped: no login"));

  if (repository && client) {
    const [owner, name] = repository.split("/");

    try {
      store = await client.findStore({ owner: owner ?? "", name: name ?? "" });

      if (!store) {
        checks.push(
          fail(
            "repository",
            `${repository} has no trace store; onboarding needs push access`,
            "dev-traces onboard",
          ),
        );
      } else if (store.status !== "active") {
        checks.push(
          fail(
            "repository",
            `${repository} store is ${store.status}`,
            "dev-traces onboard",
          ),
        );
      } else {
        checks.push(
          ok(
            "repository",
            `${repository} store ${store.repositoryId} is active`,
          ),
        );
      }
    } catch (error) {
      const forbidden =
        error instanceof StoreApiError && error.code === "forbidden";

      checks.push(
        forbidden
          ? fail("repository", `no read access to ${repository}`)
          : fail("repository", errorMessage(error), "dev-traces onboard"),
      );
    }
  }

  // 5. The consent, the capture switch, and the selected store.
  if (!repository) {
    checks.push(fail("consent", "skipped: no repository"));
  } else {
    const consent = findTraceRepository(
      await readTraceUserConfig(scope.devHome),
      repository,
    );

    const allowed = consent?.enabledOrigins.includes(origin) ?? false;

    if (!allowed) {
      checks.push(
        fail("consent", `${repository} is not allowed at ${origin}`, ALLOW_FIX),
      );
    } else if (!hostedCaptureEnabled(readTraceConfigFile(scope).config)) {
      checks.push(
        fail("consent", "the hosted capture switch is off", ALLOW_FIX),
      );
    } else if (selection.mode === "s3") {
      checks.push(
        fail(
          "consent",
          "this machine sends traces to a bucket, not the hosted store",
          "review trace storage use hosted",
        ),
      );
    } else {
      checks.push(
        ok("consent", `${repository} allowed at ${origin}; capture on`),
      );
    }
  }

  // 6. The harness hooks and the Git hooks.
  const owners = await describeTraceHookOwners(scope.homeDir);
  const ownerParts: string[] = [];
  const foreign: string[] = [];

  for (const agent of HOOK_AGENTS) {
    const owner = owners[agent];
    ownerParts.push(`${agent} -> ${owner ?? "none"}`);

    if (owner === "dev-traces") continue;

    if (await present(agentTraceHookPath(agent, scope.homeDir))) {
      foreign.push(agent);
    }
  }

  const repositoryHooks = await traceRepositoryStatus(input.cwd);
  const expectedCommand = renderTraceCommand({ file: shim });

  const gitHooksOk =
    repositoryHooks.enabled && repositoryHooks.command === expectedCommand;

  const gitDetail = gitHooksOk
    ? `git hooks call ${shim}`
    : repositoryHooks.enabled
      ? `git hooks call ${repositoryHooks.command ?? "an unknown command"}`
      : "git hooks are not enabled";

  const hookDetail = `${ownerParts.join(", ")}; ${gitDetail}`;

  checks.push(
    foreign.length === 0 && gitHooksOk
      ? ok("hooks", hookDetail)
      : fail(
          "hooks",
          hookDetail,
          foreign.length === 0 ? "dev-traces repair ." : ALLOW_FIX,
        ),
  );

  // 7. The work in flight. This check reports; only a failed sync fails it.
  const pending = await pendingSessionCount(input.cwd);
  const failures = await listTraceSyncFailures(scope.devHome);
  let newest = "no published session";

  if (!client || store?.status !== "active") {
    newest = "newest published session: not read";
  } else {
    try {
      const page = await client.listSessions(store.repositoryId, { limit: 1 });
      const latest = page.sessions[0];

      if (latest) newest = `newest published ${latest.sessionId}`;
    } catch (error) {
      newest = `listing failed: ${errorMessage(error)}`;
    }
  }

  const activityDetail = `${pending} pending session${pending === 1 ? "" : "s"}; ${newest}`;
  const first = failures[0];

  if (first) {
    // One line stays readable, so it names the oldest failures and counts
    // the rest. `dev-traces status` prints every record in full.
    const reasons: string[] = [];

    for (const failure of failures.slice(0, MAX_REPORTED_FAILURES)) {
      reasons.push(
        `${failure.session} (${failure.reason ?? "sync_failed"}): ${failure.error}`,
      );
    }

    const more = failures.length - reasons.length;

    if (more > 0) reasons.push(`and ${more} more`);

    checks.push(
      fail(
        "activity",
        `${activityDetail}; ${failures.length} sync failure${failures.length === 1 ? "" : "s"}: ${reasons.join("; ")}`,
        `dev-traces sync ${first.session}`,
      ),
    );
  } else {
    checks.push(ok("activity", activityDetail));
  }

  // The report. Under --json stdout carries one event and the lines move to
  // stderr, so a caller parses stdout without stripping prose out of it.
  const output: CliJsonOutput = {
    json: input.json,
    stdout: nodeWritable(input.stdout),
    stderr: nodeWritable(input.stderr),
  };

  const human = humanStream(output);
  let failed = 0;

  for (const check of checks) {
    human.write(
      `${check.ok ? "ok  " : "FAIL"}  ${check.name}: ${check.detail}\n`,
    );

    if (check.fix) human.write(`      fix: ${check.fix}\n`);

    if (!check.ok) failed += 1;
  }

  human.write(
    failed === 0 ? "All checks passed.\n" : `${failed} check(s) failed.\n`,
  );
  emitJsonEvent(output, {
    event: "trace.check",
    checks,
    ok: failed === 0,
  });

  return failed === 0 ? 0 : 1;
}
