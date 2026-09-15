import type { Writable } from "node:stream";

import { git } from "@dev.fast/local-vcs";
import {
  type ListSessionsResponse,
  MAX_TRACE_SESSIONS_PAGE,
  type StoreResponse,
  sessionIdSchema,
} from "@dev.fast/trace-protocol";

import {
  describeTraceHookOwners,
  installHarnessHooks,
} from "./agent-trace-hooks";
import {
  type CliJsonOutput,
  emitJsonEvent,
  failWithJsonError,
  humanStream,
} from "./cli-output";
import { errorMessage } from "./error-message";
import { readStoreAuth, requireStoreClient } from "./store-auth";
import { StoreApiError, StoreClient } from "./store-client";
import { readActiveTraceSessions } from "./trace-agent-sessions";
import { HOSTED_CAPTURE_SCOPE_DESCRIPTION } from "./trace-capture-scope";
import {
  type TraceCommand,
  type TraceScope,
  traceCliName,
  traceCommandPrefix,
} from "./trace-command";
import {
  allowTraceRepository,
  denyTraceRepository,
  findTraceRepository,
  readTraceUserConfig,
} from "./trace-consent";
import { type TraceRepo, inferRepoFromGit, traceRepoName } from "./trace-repo";
import {
  enableTraceRepository,
  traceRepositoryStatus,
} from "./trace-repository-hooks";
import { readCachedTraceRepositoryTarget } from "./trace-repository-target";
import {
  DEFAULT_HOSTED_ORIGIN,
  emptyTraceConfig,
  hostedCaptureEnabled,
  hostedOrigin,
  readTraceConfigFile,
  writeTraceConfigFile,
} from "./trace-storage/config";
import { traceNameFromObject } from "./trace-storage/hosted";
import { selectTraceStorage } from "./trace-storage/resolve";
import type { TraceStorageKind } from "./trace-storage/types";
import {
  describeTraceSyncFailure,
  listTraceSyncFailures,
} from "./trace-sync-status";
import { writeOwnUploadStatus } from "./trace-upload-status";

/** A store failure as one sentence the user can act on. */
function describeStoreFailure(
  error: Error,
  origin: string,
  repository: string,
): string {
  if (!(error instanceof StoreApiError)) {
    return `Could not reach the trace store at ${origin}: ${error.message}`;
  }

  switch (error.code) {
    case "unauthorized":
      return `The trace store at ${origin} rejected the login. Run \`${traceCliName()} login --origin ${origin}\`.`;
    case "forbidden":
      return `You cannot read the traces of ${repository}: ${error.message}`;
    case "store_deleted":
      return `The trace store of ${repository} was deleted. Run \`${traceCommandPrefix()} store create\` to create a new one.`;
    case "not_found":
      return `${repository} has no trace store. Run \`${traceCommandPrefix()} store create\` first.`;
    default:
      return `The trace store at ${origin} answered ${error.code}: ${error.message}`;
  }
}

/** A failure a hosted command reports on both channels, then exits 1. */
class HostedCommandFailure extends Error {}

interface HostedRepositoryContext {
  name: TraceRepo;
  repository: string;
  origin: string;
  client: StoreClient;
  stage: "store.create" | "store.delete" | "store.info" | "allow" | "sessions";
}

/** Shares repository inference without changing each command's login policy. */
async function withHostedRepository(
  input: CliJsonOutput & {
    scope: TraceScope;
    cwd: string;
    client?: StoreClient;
    origin?: string;
  },
  stage: HostedRepositoryContext["stage"],
  fn: (ctx: HostedRepositoryContext) => Promise<number>,
): Promise<number> {
  const fail = (message: string): number =>
    failWithJsonError(input, stage, message);

  let name: TraceRepo;

  try {
    name = await inferRepoFromGit(input.cwd);
  } catch (error) {
    return fail(errorMessage(error));
  }

  let origin = input.origin ?? DEFAULT_HOSTED_ORIGIN;
  let client = input.client;

  if (stage === "store.create") {
    try {
      client ??= await requireStoreClient(input.scope.env);
    } catch (error) {
      return fail(errorMessage(error));
    }
  } else if (stage === "allow" || !client) {
    // Consent always needs the saved destination, even with an injected client.
    const auth = await readStoreAuth(input.scope.env);

    if (!auth) {
      return fail(
        stage === "allow"
          ? `Run \`${traceCliName()} login\` first.`
          : `The trace store login is missing. Run \`${traceCliName()} login --origin ${origin}\`.`,
      );
    }

    origin = input.origin ?? auth.origin;

    if (auth.origin !== origin) {
      return fail(
        `You are logged in to ${auth.origin}, not the selected store ${origin}. Run \`${traceCliName()} login --origin ${origin}\`.`,
      );
    }

    client ??= new StoreClient({ origin, token: auth.token });
  }

  try {
    return await fn({
      name,
      repository: traceRepoName(name),
      origin,
      client,
      stage,
    });
  } catch (error) {
    if (error instanceof HostedCommandFailure) return fail(error.message);
    throw error;
  }
}

/** Requires an active store, preserving the command's store-error wording. */
async function requireActiveStore(
  ctx: HostedRepositoryContext,
): Promise<StoreResponse> {
  let store: StoreResponse | null;

  try {
    store = await ctx.client.findStore({
      owner: ctx.name.owner,
      name: ctx.name.repo,
    });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    throw new HostedCommandFailure(
      ctx.stage === "sessions"
        ? describeStoreFailure(failure, ctx.origin, ctx.repository)
        : failure.message,
    );
  }

  if (!store) {
    throw new HostedCommandFailure(
      `${ctx.repository} has no trace store. Run \`${traceCommandPrefix()} store create\` first.`,
    );
  }

  if (store.status !== "active") {
    throw new HostedCommandFailure(
      `The trace store of ${store.displayName} was deleted. Run \`${traceCommandPrefix()} store create\` to create a new one.`,
    );
  }

  return store;
}

/**
 * Hosted consent commands: onboarding creates a repository store, allow
 * records publication consent bound to the login's origin, deny withdraws
 * it. None of them selects hosted storage; the trace storage use
 * hosted` does that explicitly.
 */

export async function runTraceOnboard(
  input: CliJsonOutput & {
    scope: TraceScope;
    cwd: string;
    client?: StoreClient;
  },
): Promise<number> {
  return withHostedRepository(input, "store.create", async (ctx) => {
    let store: Awaited<ReturnType<StoreClient["createStore"]>>;

    try {
      store = await ctx.client.createStore({
        owner: ctx.name.owner,
        name: ctx.name.repo,
      });
    } catch (error) {
      if (error instanceof StoreApiError && error.code === "forbidden") {
        throw new HostedCommandFailure(
          `You need push access to ${ctx.repository} to create its trace store.`,
        );
      }

      throw new HostedCommandFailure(errorMessage(error));
    }

    emitJsonEvent(input, {
      event: "trace.onboard",
      repositoryId: store.repositoryId,
      displayName: store.displayName,
      created: store.created === true,
    });
    const stream = humanStream(input);
    stream.write(
      `Created the trace store of ${store.displayName} (id ${store.repositoryId}).\n`,
    );
    stream.write(
      `Run \`${traceCommandPrefix()} allow .\` to send traces from this repository.\n`,
    );

    return 0;
  });
}

/** Reports the hosted store of one repository, or exits 1 without one. */
export async function runTraceStoreInfo(
  input: CliJsonOutput & {
    scope: TraceScope;
    cwd: string;
    client?: StoreClient;
  },
): Promise<number> {
  return withHostedRepository(input, "store.info", async (ctx) => {
    let store: StoreResponse | null;

    try {
      store = await ctx.client.findStore({
        owner: ctx.name.owner,
        name: ctx.name.repo,
      });
    } catch (error) {
      throw new HostedCommandFailure(
        describeStoreFailure(
          error instanceof Error ? error : new Error(String(error)),
          ctx.origin,
          ctx.repository,
        ),
      );
    }

    if (!store) {
      throw new HostedCommandFailure(
        `${ctx.repository} has no trace store. Run \`${traceCommandPrefix()} store create\` first.`,
      );
    }

    emitJsonEvent(input, {
      event: "trace.store",
      repository: store.displayName,
      repositoryId: store.repositoryId,
      storeId: store.storeId,
      status: store.status,
      bytesStored: store.bytesStored ?? null,
    });
    const stream = humanStream(input);
    stream.write(
      `Repository: ${store.displayName} (id ${store.repositoryId})\n`,
    );
    stream.write(`Store: ${store.storeId} (${store.status})\n`);

    if (store.bytesStored !== undefined) {
      stream.write(`Stored bytes: ${store.bytesStored}\n`);
    }

    return 0;
  });
}

/**
 * Deletes the hosted store of one repository. The deletion is logical: the
 * store stops every read and write at once, and an operator removes the
 * objects later. The consent of this machine stays; `deny` removes that.
 */
export async function runTraceStoreDelete(
  input: CliJsonOutput & {
    scope: TraceScope;
    cwd: string;
    client?: StoreClient;
  },
): Promise<number> {
  return withHostedRepository(input, "store.delete", async (ctx) => {
    const store = await requireActiveStore(ctx);

    let deletion: Awaited<ReturnType<StoreClient["deleteStore"]>>;

    try {
      deletion = await ctx.client.deleteStore(store.repositoryId);
    } catch (error) {
      if (error instanceof StoreApiError && error.code === "forbidden") {
        throw new HostedCommandFailure(
          `Deleting the store of ${ctx.repository} needs admin access to the repository.`,
        );
      }

      throw new HostedCommandFailure(errorMessage(error));
    }

    emitJsonEvent(input, {
      event: "trace.store.delete",
      repository: store.displayName,
      repositoryId: deletion.repositoryId,
      storeId: deletion.storeId,
      status: deletion.status,
    });
    humanStream(input).write(
      `Store deletion requested for ${store.displayName} (store ${deletion.storeId}). Uploaded objects are removed by a later operator cleanup.\n`,
    );

    return 0;
  });
}

export async function runTraceAllow(
  input: CliJsonOutput & { scope: TraceScope } & {
    cwd: string;
    client?: StoreClient;
    harnessHooks?: boolean;
    /** The executable the installed hooks run; the CLI name when absent. */
    traceCommand?: TraceCommand;
    /**
     * The command the last line names, because only the CLI knows which one
     * it registers. `<prefix> status` when absent.
     */
    verifyCommand?: string;
  },
): Promise<number> {
  return withHostedRepository(input, "allow", async (ctx) => {
    // Consent is hosted-only. A machine that sends traces to a bucket keeps
    // doing so until the user selects the hosted store explicitly.
    const selection = selectTraceStorage(input.scope);

    if (selection.error)
      return failWithJsonError(input, "allow", selection.error);

    if (selection.mode === "s3") {
      return failWithJsonError(
        input,
        "allow",
        `This machine sends traces to a bucket. Run \`review trace storage use hosted\` first.`,
      );
    }

    const storeOrigin = ctx.origin;
    const store = await requireActiveStore(ctx);

    await installHarnessHooks({
      homeDir: input.scope.homeDir,
      executable: input.traceCommand?.file,
      harnessHooks: input.harnessHooks,
    });

    await enableTraceRepository({
      cwd: input.cwd,
      scope: input.scope,
      reviewCommand: input.traceCommand,
    });
    await enableHostedCapture(input.scope.devHome, storeOrigin);
    await allowTraceRepository(
      {
        repositoryId: store.repositoryId,
        name: store.displayName,
        origin: storeOrigin,
      },
      input.scope.devHome,
    );

    emitJsonEvent(input, {
      event: "trace.allow",
      repositoryId: store.repositoryId,
      name: store.displayName,
      store: storeOrigin,
    });

    const verifyCommand =
      input.verifyCommand ?? `${traceCommandPrefix()} status`;

    humanStream(input).write(
      `Traces from ${store.displayName} may be published to ${storeOrigin}. Run \`${verifyCommand}\` to verify.\n`,
    );

    return 0;
  });
}

/**
 * Switches hosted capture on. An uninstall leaves `capture.enabled: false`
 * behind; a later allow means the user wants capture back. A file with no
 * hosted entry gets one that names the login's origin.
 */
async function enableHostedCapture(
  devHome: string,
  origin: string,
): Promise<void> {
  const file = readTraceConfigFile({ devHome });
  const current = file.config ?? emptyTraceConfig();
  const hosted = current.stores?.hosted;

  if (hosted?.capture?.enabled === true) return;

  await writeTraceConfigFile(file, {
    ...current,
    stores: {
      ...current.stores,
      hosted: hosted
        ? { ...hosted, capture: { enabled: true } }
        : { origin, capture: { enabled: true } },
    },
  });
}

export async function runTraceDeny(
  input: CliJsonOutput & { scope: TraceScope } & {
    cwd: string;
  },
): Promise<number> {
  let name: string;

  try {
    name = traceRepoName(await inferRepoFromGit(input.cwd));
  } catch (error) {
    return failWithJsonError(input, "deny", errorMessage(error));
  }

  const devHome = input.scope.devHome;

  // The id this checkout resolved to earlier, if any, so a renamed
  // repository is still found. No network is needed to deny.
  const cached = await readCachedTraceRepositoryTarget({
    cwd: input.cwd,
    origin: hostedOrigin(readTraceConfigFile({ devHome }).config),
    devHome,
  }).catch(() => null);

  const removed = await denyTraceRepository(
    { name, repositoryId: cached?.repositoryId ?? null },
    devHome,
  );

  emitJsonEvent(input, { event: "trace.deny", name, removed });
  humanStream(input).write(
    removed
      ? `${name} will no longer publish traces.\n`
      : `${name} was not allowed to publish traces.\n`,
  );

  return 0;
}

/** Sessions per page when `--limit` is not given. */
export const DEFAULT_TRACE_SESSIONS_LIMIT = 50;

/** One session as the CLI reports it: no signed URL, no expiry. */
interface ListedTraceSession {
  id: string;
  harness: string;
  updatedAt: string;
  branch: string | null;
  author: string | null;
  generation: number;
  commits: string[];
  traces: string[];
  bytes: number;
}

function listedSession(
  session: ListSessionsResponse["sessions"][number],
): ListedTraceSession {
  let bytes = 0;

  for (const object of session.objects) bytes += object.size;

  return {
    id: session.sessionId,
    harness: session.harness,
    updatedAt: session.updatedAt,
    branch: session.branch ?? null,
    author: session.author ?? null,
    generation: session.generation,
    commits: session.commits,
    traces: session.objects.map((object) => traceNameFromObject(object.name)),
    bytes,
  };
}

/**
 * Lists every published session of this checkout's hosted store, one page
 * at a time. The command reads the store live: a missing login, a store
 * that does not answer, or a refusal is a failure, never a saved copy.
 * Reading needs no local publication consent; the store checks GitHub
 * access itself.
 */
export async function runTraceSessions(
  input: CliJsonOutput & { scope: TraceScope } & {
    cwd: string;
    limit?: number;
    cursor?: string;
    storage?: TraceStorageKind;
    client?: StoreClient;
  },
): Promise<number> {
  const fail = (message: string): number =>
    failWithJsonError(input, "sessions", message);

  // The store rejects a bad page size or cursor as `invalid_request`, which
  // this command reads as an older store. Bound both flags here, so that
  // answer can only mean the store is older than the unfiltered listing.
  if (
    input.limit !== undefined &&
    (!Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > MAX_TRACE_SESSIONS_PAGE)
  ) {
    return fail(
      `--limit must be a whole number from 1 to ${MAX_TRACE_SESSIONS_PAGE}.`,
    );
  }

  if (
    input.cursor !== undefined &&
    !sessionIdSchema.safeParse(input.cursor).success
  ) {
    return fail("--cursor must be a session id from a previous page.");
  }

  const selection = selectTraceStorage(input.scope);

  const mode = input.storage ?? selection.mode;

  // The s3 refusal comes first. A machine that selects s3 then reads the
  // store this command needs, not a bucket configuration error it cannot act
  // on here.
  if (mode === "s3") {
    return fail(
      `\`${traceCommandPrefix()} sessions\` lists the hosted store only. Run \`review trace storage use hosted\`, or pass \`--storage hosted\`.`,
    );
  }

  // An override to hosted sidesteps an s3 configuration error, because the
  // hosted store this command reads needs no bucket credentials. A malformed
  // config names no hosted store, so it still fails with its own error.
  if (selection.error && (mode !== "hosted" || !selection.hosted)) {
    return fail(selection.error);
  }

  if (!selection.hosted) {
    return fail(
      `Hosted trace storage is not configured. Run \`${traceCommandPrefix()} allow .\` or \`review trace storage use hosted\`.`,
    );
  }

  return withHostedRepository(
    { ...input, origin: selection.hosted.origin },
    "sessions",
    async (ctx) => {
      const store = await requireActiveStore(ctx);
      const origin = ctx.origin;

      const query =
        input.cursor === undefined
          ? { limit: input.limit ?? DEFAULT_TRACE_SESSIONS_LIMIT }
          : {
              limit: input.limit ?? DEFAULT_TRACE_SESSIONS_LIMIT,
              cursor: input.cursor,
            };

      let page: ListSessionsResponse;

      try {
        page = await ctx.client.listSessions(store.repositoryId, query);
      } catch (error) {
        if (
          error instanceof StoreApiError &&
          error.code === "invalid_request"
        ) {
          throw new HostedCommandFailure(
            `The trace store at ${origin} does not support listing every session yet. Update the store, or use \`${traceCommandPrefix()} list --commit <sha>\`.`,
          );
        }

        throw new HostedCommandFailure(
          describeStoreFailure(
            error instanceof Error ? error : new Error(String(error)),
            origin,
            store.displayName,
          ),
        );
      }

      const sessions = page.sessions.map(listedSession);

      emitJsonEvent(input, {
        event: "trace.sessions",
        repository: store.displayName,
        repositoryId: store.repositoryId,
        store: origin,
        sessions,
        nextCursor: page.nextCursor ?? null,
      });

      const stream = humanStream(input);

      if (sessions.length === 0) {
        stream.write(
          `No published sessions in the trace store of ${store.displayName} at ${origin}.\n`,
        );

        return 0;
      }

      for (const session of sessions) {
        stream.write(
          `${session.id}  ${session.harness}  ${session.updatedAt}  ${session.branch ?? "-"}  ${session.bytes} bytes\n`,
        );
      }

      // The next-page command repeats every flag this page was read with.
      const nextPageFlags =
        (input.limit === undefined ? "" : ` --limit ${input.limit}`) +
        (input.storage === undefined ? "" : ` --storage ${input.storage}`);

      stream.write(
        page.nextCursor
          ? `Sessions are ordered by id. More follow: run \`${traceCommandPrefix()} sessions${nextPageFlags} --cursor ${page.nextCursor}\`.\n`
          : "Sessions are ordered by id. This is the last page.\n",
      );

      return 0;
    },
  );
}

/** The hosted trace status lines: login, consent, and pending work. */
export async function writeHostedTraceStatus(
  input: { scope: TraceScope } & {
    cwd: string;
    origin: string;
    stdout: Writable;
    client?: StoreClient;
    session?: string;
    cursor?: string;
    limit?: number;
  },
): Promise<number> {
  const stream = input.stdout;
  stream.write(HOSTED_CAPTURE_SCOPE_DESCRIPTION);
  const devHome = input.scope.devHome;
  const auth = await readStoreAuth(input.scope.env);
  const config = await readTraceUserConfig(devHome);
  stream.write(
    auth
      ? `Login: ${auth.login} at ${auth.origin}${
          auth.origin === input.origin
            ? ""
            : ` (selected store is ${input.origin}; run \`${traceCliName()} login --origin ${input.origin}\`)`
        }\n`
      : `Login: none. Run \`${traceCliName()} login --origin ${input.origin}\`.\n`,
  );
  stream.write(
    `Capture switch: ${hostedCaptureEnabled(readTraceConfigFile({ devHome }).config) ? "on" : "off"}\n`,
  );

  const owners = await describeTraceHookOwners(input.scope.homeDir);
  stream.write(
    `Harness hooks: claude -> ${owners.claude ?? "none"}, codex -> ${owners.codex ?? "none"}, opencode -> ${owners.opencode ?? "none"}, pi -> ${owners.pi ?? "none"}\n`,
  );

  const repositoryHooks = await traceRepositoryStatus(input.cwd);
  stream.write(
    `Git hooks: ${repositoryHooks.enabled ? (repositoryHooks.command ?? "enabled") : "not enabled"}\n`,
  );

  if (config.repositories.length === 0) {
    stream.write(
      `Allowed repositories: none. Run \`${traceCommandPrefix()} allow .\`.\n`,
    );
  } else {
    for (const repository of config.repositories) {
      stream.write(
        `Allowed repository: ${repository.name} (id ${repository.repositoryId}) -> ${repository.enabledOrigins.join(", ")}\n`,
      );
    }
  }

  let repo: TraceRepo | null = null;

  try {
    repo = await inferRepoFromGit(input.cwd);
  } catch {
    repo = null;
  }

  if (repo === null) {
    stream.write("This directory has no GitHub remote to check.\n");
  } else {
    const name = traceRepoName(repo);
    const entry = findTraceRepository(config, name);

    if (!entry) {
      stream.write(
        `This repository (${name}) is not allowed. Run \`${traceCommandPrefix()} allow .\`.\n`,
      );
    } else if (!entry.enabledOrigins.includes(input.origin)) {
      stream.write(
        `This repository (${name}) is allowed at ${entry.enabledOrigins.join(", ")}, not the selected ${input.origin}. Run \`${traceCommandPrefix()} allow .\` while logged in there.\n`,
      );
    } else {
      stream.write(
        `This repository (${name}) is allowed to publish traces to ${input.origin}.\n`,
      );
    }
  }

  for (const sessionId of await pendingTraceSessions(input.cwd)) {
    if (input.session !== undefined && input.session !== sessionId) continue;
    stream.write(`Pending agent session: ${sessionId}\n`);
  }

  for (const failure of await listTraceSyncFailures(devHome)) {
    if (input.session === undefined || input.session === failure.session)
      stream.write(describeTraceSyncFailure(failure));
  }

  if (repo === null) return 1;

  return writeOwnUploadStatus({
    ...input,
    repo,
    client:
      input.client ??
      (auth && auth.origin === input.origin
        ? new StoreClient({ origin: auth.origin, token: auth.token })
        : null),
  });
}

/** The agent sessions still marked active in this checkout. */
async function pendingTraceSessions(cwd: string): Promise<string[]> {
  const gitPathResult = await git(
    cwd,
    ["rev-parse", "--git-path", "agent-session"],
    { allowFailure: true },
  );

  const sessionFilePath = gitPathResult.ok ? gitPathResult.stdout.trim() : "";

  if (!sessionFilePath) return [];
  const sessions = await readActiveTraceSessions(sessionFilePath);

  return [...sessions.keys()];
}
