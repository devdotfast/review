import type { Writable } from "node:stream";

import { git } from "@dev.fast/local-vcs";
import {
  type ListSessionsResponse,
  MAX_TRACE_SESSIONS_PAGE,
  type StoreResponse,
  sessionIdSchema,
} from "@dev.fast/trace-shared";

import {
  installClaudeTraceHook,
  installCodexTraceHook,
  installOpenCodeTraceExtension,
  installPiTraceExtension,
} from "./agent-trace-hooks";
import {
  type CliJsonOutput,
  emitJsonEvent,
  failWithJsonError,
  humanStream,
} from "./cli-output";
import { devReviewHome } from "./review-storage";
import { readStoreAuth, requireStoreClient } from "./store-auth";
import { StoreApiError, StoreClient } from "./store-client";
import { readActiveTraceSessions } from "./trace-agent-sessions";
import { HOSTED_CAPTURE_SCOPE_DESCRIPTION } from "./trace-capture-scope";
import { traceCliName } from "./trace-command";
import { type TraceRepo, inferRepoFromGit, traceRepoName } from "./trace-repo";
import { enableTraceRepository } from "./trace-repository-hooks";
import { readCachedTraceRepositoryTarget } from "./trace-repository-target";
import { hostedOrigin, readTraceConfigFile } from "./trace-storage/config";
import { traceNameFromObject } from "./trace-storage/hosted";
import { selectTraceStorage } from "./trace-storage/resolve";
import type { TraceStorageKind } from "./trace-storage/types";
import {
  describeTraceSyncFailure,
  listTraceSyncFailures,
} from "./trace-sync-status";
import { writeOwnUploadStatus } from "./trace-upload-status";
import {
  allowTraceRepository,
  denyTraceRepository,
  findTraceRepository,
  readTraceUserConfig,
} from "./trace-user-config";

/**
 * Hosted consent commands: onboarding creates a repository store, allow
 * records publication consent bound to the login's origin, deny withdraws
 * it. None of them selects hosted storage; the trace storage use
 * hosted` does that explicitly.
 */

interface HostedCommandScope {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export async function runReviewTraceOnboard(
  input: CliJsonOutput &
    HostedCommandScope & { cwd: string; client?: StoreClient },
): Promise<number> {
  let name: { owner: string; repo: string };

  try {
    name = await inferRepoFromGit(input.cwd);
  } catch (error) {
    return failWithJsonError(
      input,
      "onboard",
      error instanceof Error ? error.message : String(error),
    );
  }

  let client: StoreClient;

  try {
    client = input.client ?? (await requireStoreClient(input.env));
  } catch (error) {
    return failWithJsonError(
      input,
      "onboard",
      error instanceof Error ? error.message : String(error),
    );
  }

  let store: Awaited<ReturnType<StoreClient["createStore"]>>;

  try {
    store = await client.createStore({ owner: name.owner, name: name.repo });
  } catch (error) {
    if (error instanceof StoreApiError && error.code === "forbidden") {
      return failWithJsonError(
        input,
        "onboard",
        `You need write access to ${traceRepoName(name)} to onboard it.`,
      );
    }

    return failWithJsonError(
      input,
      "onboard",
      error instanceof Error ? error.message : String(error),
    );
  }

  emitJsonEvent(input, {
    event: "trace.onboard",
    repositoryId: store.repositoryId,
    displayName: store.displayName,
    created: store.created === true,
  });
  const stream = humanStream(input);
  stream.write(`Onboarded ${store.displayName} (id ${store.repositoryId}).\n`);
  stream.write(
    `Run \`${traceCliName()} trace allow .\` to send traces from this repository.\n`,
  );

  return 0;
}

export async function runReviewTraceAllow(
  input: CliJsonOutput &
    HostedCommandScope & {
      cwd: string;
      client?: StoreClient;
      harnessHooks?: boolean;
    },
): Promise<number> {
  let name: { owner: string; repo: string };

  try {
    name = await inferRepoFromGit(input.cwd);
  } catch (error) {
    return failWithJsonError(
      input,
      "allow",
      error instanceof Error ? error.message : String(error),
    );
  }

  // The allow entry records the exact destination, so a login is required
  // before the user can allow anything.
  const auth = await readStoreAuth(input.env);

  if (!auth) {
    return failWithJsonError(
      input,
      "allow",
      `Run \`${traceCliName()} login\` first.`,
    );
  }

  const storeOrigin = auth.origin;

  const client =
    input.client ?? new StoreClient({ origin: storeOrigin, token: auth.token });

  let store: Awaited<ReturnType<StoreClient["findStore"]>>;

  try {
    store = await client.findStore({ owner: name.owner, name: name.repo });
  } catch (error) {
    return failWithJsonError(
      input,
      "allow",
      error instanceof Error ? error.message : String(error),
    );
  }

  if (!store) {
    return failWithJsonError(
      input,
      "allow",
      `${traceRepoName(name)} is not onboarded. Run \`${traceCliName()} trace onboard\` first.`,
    );
  }

  if (store.status !== "active") {
    return failWithJsonError(
      input,
      "allow",
      `The trace store of ${store.displayName} was deleted. Run \`${traceCliName()} trace onboard\` to create a new one.`,
    );
  }

  if (input.harnessHooks !== false) {
    await installClaudeTraceHook(input.homeDir);
    await installCodexTraceHook(input.homeDir);
    await installOpenCodeTraceExtension(input.homeDir);
    await installPiTraceExtension(input.homeDir);
  }

  await enableTraceRepository({ cwd: input.cwd, homeDir: input.homeDir });
  await allowTraceRepository(
    {
      repositoryId: store.repositoryId,
      name: store.displayName,
      origin: storeOrigin,
    },
    devReviewHome(input.env, input.homeDir),
  );

  emitJsonEvent(input, {
    event: "trace.allow",
    repositoryId: store.repositoryId,
    name: store.displayName,
    store: storeOrigin,
  });
  humanStream(input).write(
    `Traces from ${store.displayName} may be published to ${storeOrigin}. A machine with no bucket configured now uses the hosted store; one with a bucket needs \`${traceCliName()} trace storage use hosted\`.\n`,
  );

  return 0;
}

export async function runReviewTraceDeny(
  input: CliJsonOutput &
    HostedCommandScope & {
      cwd: string;
      /** Also delete the hosted store (repository admins only). */
      deleteStore?: boolean;
      client?: StoreClient;
    },
): Promise<number> {
  let name: string;

  try {
    name = traceRepoName(await inferRepoFromGit(input.cwd));
  } catch (error) {
    return failWithJsonError(
      input,
      "deny",
      error instanceof Error ? error.message : String(error),
    );
  }

  const devHome = devReviewHome(input.env, input.homeDir);

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

  let deletion: Awaited<ReturnType<StoreClient["deleteStore"]>> | null = null;

  if (input.deleteStore) {
    let client: StoreClient;

    try {
      client = input.client ?? (await requireStoreClient(input.env));
    } catch (error) {
      return failWithJsonError(
        input,
        "deny",
        error instanceof Error ? error.message : String(error),
      );
    }

    const repositoryId = cached?.repositoryId ?? null;

    if (repositoryId === null) {
      return failWithJsonError(
        input,
        "deny",
        `${name} has no resolved hosted store on this machine. Run \`${traceCliName()} trace allow .\` once, then deny with --delete-store.`,
      );
    }

    try {
      deletion = await client.deleteStore(repositoryId);
    } catch (error) {
      if (error instanceof StoreApiError && error.code === "forbidden") {
        return failWithJsonError(
          input,
          "deny",
          `Deleting the store of ${name} needs admin access to the repository.`,
        );
      }

      return failWithJsonError(
        input,
        "deny",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  emitJsonEvent(input, {
    event: "trace.deny",
    name,
    removed,
    storeDeleted: deletion !== null,
  });
  const stream = humanStream(input);
  stream.write(
    removed
      ? `${name} will no longer publish traces.\n`
      : `${name} was not allowed to publish traces.\n`,
  );

  if (deletion) {
    stream.write(
      `Store deletion requested for ${name} (store ${deletion.storeId}). Uploaded objects are removed by a later operator cleanup.\n`,
    );
  }

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
      return `The trace store of ${repository} was deleted. Run \`${traceCliName()} trace onboard\` to create a new one.`;
    case "not_found":
      return `${repository} is not onboarded. Run \`${traceCliName()} trace onboard\` first.`;
    default:
      return `The trace store at ${origin} answered ${error.code}: ${error.message}`;
  }
}

/**
 * Lists every published session of this checkout's hosted store, one page
 * at a time. The command reads the store live: a missing login, a store
 * that does not answer, or a refusal is a failure, never a saved copy.
 * Reading needs no local publication consent; the store checks GitHub
 * access itself.
 */
export async function runReviewTraceSessions(
  input: CliJsonOutput &
    HostedCommandScope & {
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

  const selection = selectTraceStorage({
    env: input.env,
    homeDir: input.homeDir,
  });

  const mode = input.storage ?? selection.mode;

  // The s3 refusal comes first. A machine that selects s3 then reads the
  // store this command needs, not a bucket configuration error it cannot act
  // on here.
  if (mode === "s3") {
    return fail(
      `\`${traceCliName()} trace sessions\` lists the hosted store only. Run \`${traceCliName()} trace storage use hosted\`, or pass \`--storage hosted\`.`,
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
      `Hosted trace storage is not configured. Run \`${traceCliName()} trace allow .\` or \`${traceCliName()} trace storage use hosted\`.`,
    );
  }

  const origin = selection.hosted.origin;
  let name: { owner: string; repo: string };

  try {
    name = await inferRepoFromGit(input.cwd);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const repository = traceRepoName(name);
  let client = input.client;

  if (!client) {
    const auth = await readStoreAuth(input.env);

    if (!auth || auth.origin !== origin) {
      return fail(
        auth
          ? `You are logged in to ${auth.origin}, not the selected store ${origin}. Run \`${traceCliName()} login --origin ${origin}\`.`
          : `The trace store login is missing. Run \`${traceCliName()} login --origin ${origin}\`.`,
      );
    }

    client = new StoreClient({ origin, token: auth.token });
  }

  let store: StoreResponse | null;

  try {
    store = await client.findStore({ owner: name.owner, name: name.repo });
  } catch (error) {
    return fail(
      describeStoreFailure(
        error instanceof Error ? error : new Error(String(error)),
        origin,
        repository,
      ),
    );
  }

  if (!store) {
    return fail(
      `${repository} is not onboarded. Run \`${traceCliName()} trace onboard\` first.`,
    );
  }

  if (store.status !== "active") {
    return fail(
      `The trace store of ${store.displayName} was deleted. Run \`${traceCliName()} trace onboard\` to create a new one.`,
    );
  }

  const query =
    input.cursor === undefined
      ? { limit: input.limit ?? DEFAULT_TRACE_SESSIONS_LIMIT }
      : {
          limit: input.limit ?? DEFAULT_TRACE_SESSIONS_LIMIT,
          cursor: input.cursor,
        };

  let page: ListSessionsResponse;

  try {
    page = await client.listSessions(store.repositoryId, query);
  } catch (error) {
    if (error instanceof StoreApiError && error.code === "invalid_request") {
      return fail(
        `The trace store at ${origin} does not support listing every session yet. Update the store, or use \`${traceCliName()} trace list --commit <sha>\`.`,
      );
    }

    return fail(
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
      ? `Sessions are ordered by id. More follow: run \`${traceCliName()} trace sessions${nextPageFlags} --cursor ${page.nextCursor}\`.\n`
      : "Sessions are ordered by id. This is the last page.\n",
  );

  return 0;
}

/** The hosted trace status lines: login, consent, and pending work. */
export async function writeHostedTraceStatus(
  input: HostedCommandScope & {
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
  const devHome = devReviewHome(input.env, input.homeDir);
  const auth = await readStoreAuth(input.env);
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

  if (config.repositories.length === 0) {
    stream.write(
      `Allowed repositories: none. Run \`${traceCliName()} trace allow .\`.\n`,
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
        `This repository (${name}) is not allowed. Run \`${traceCliName()} trace allow .\`.\n`,
      );
    } else if (!entry.enabledOrigins.includes(input.origin)) {
      stream.write(
        `This repository (${name}) is allowed at ${entry.enabledOrigins.join(", ")}, not the selected ${input.origin}. Run \`${traceCliName()} trace allow .\` while logged in there.\n`,
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
