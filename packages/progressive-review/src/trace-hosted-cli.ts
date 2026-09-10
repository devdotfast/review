import type { Writable } from "node:stream";

import { git } from "@dev.fast/local-vcs";

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
import { inferRepoFromGit, traceRepoName } from "./trace-repo";
import { enableTraceRepository } from "./trace-repository-hooks";
import { readCachedTraceRepositoryTarget } from "./trace-repository-target";
import { hostedOrigin, readTraceConfigFile } from "./trace-storage/config";
import { listTraceSyncFailures } from "./trace-sync-status";
import {
  allowTraceRepository,
  denyTraceRepository,
  findTraceRepository,
  readTraceUserConfig,
} from "./trace-user-config";

/**
 * Hosted consent commands: onboarding creates a repository store, allow
 * records publication consent bound to the login's origin, deny withdraws
 * it. None of them selects hosted storage; `review trace storage use
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
    "Run `review trace allow .` to send traces from this repository.\n",
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
    return failWithJsonError(input, "allow", "Run `review login` first.");
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
      `${traceRepoName(name)} is not onboarded. Run \`review trace onboard\` first.`,
    );
  }
  if (store.status !== "active") {
    return failWithJsonError(
      input,
      "allow",
      `The trace store of ${store.displayName} was deleted. Run \`review trace onboard\` to create a new one.`,
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
    `Traces from ${store.displayName} may be published to ${storeOrigin}. Select it with \`review trace storage use hosted\` if you have not.\n`,
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
        `${name} has no resolved hosted store on this machine. Run \`review trace allow .\` once, then deny with --delete-store.`,
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

/** The hosted lines of `review trace status`: login, consent, pending work. */
export async function writeHostedTraceStatus(
  input: HostedCommandScope & {
    cwd: string;
    origin: string;
    stdout: Writable;
    client?: StoreClient;
  },
): Promise<void> {
  const stream = input.stdout;
  const devHome = devReviewHome(input.env, input.homeDir);
  const auth = await readStoreAuth(input.env);
  const config = await readTraceUserConfig(devHome);
  stream.write(
    auth
      ? `Login: ${auth.login} at ${auth.origin}${
          auth.origin === input.origin
            ? ""
            : ` (selected store is ${input.origin}; run \`review login --origin ${input.origin}\`)`
        }\n`
      : `Login: none. Run \`review login --origin ${input.origin}\`.\n`,
  );
  if (config.repositories.length === 0) {
    stream.write("Allowed repositories: none. Run `review trace allow .`.\n");
  } else {
    for (const repository of config.repositories) {
      stream.write(
        `Allowed repository: ${repository.name} (id ${repository.repositoryId}) -> ${repository.enabledOrigins.join(", ")}\n`,
      );
    }
  }
  let name: string | null = null;
  try {
    name = traceRepoName(await inferRepoFromGit(input.cwd));
  } catch {
    name = null;
  }
  if (name === null) {
    stream.write("This directory has no GitHub remote to check.\n");
  } else {
    const entry = findTraceRepository(config, name);
    if (!entry) {
      stream.write(
        `This repository (${name}) is not allowed. Run \`review trace allow .\`.\n`,
      );
    } else if (!entry.enabledOrigins.includes(input.origin)) {
      stream.write(
        `This repository (${name}) is allowed at ${entry.enabledOrigins.join(", ")}, not the selected ${input.origin}. Run \`review trace allow .\` while logged in there.\n`,
      );
    } else {
      stream.write(
        `This repository (${name}) is allowed to publish traces to ${input.origin}.\n`,
      );
      const client =
        input.client ??
        (auth && auth.origin === input.origin
          ? new StoreClient({ origin: auth.origin, token: auth.token })
          : null);
      if (client) {
        const [owner = "", repo = ""] = name.split("/");
        const store = await client
          .findStore({ owner, name: repo })
          .catch(() => null);
        if (store?.bytesStored !== undefined) {
          stream.write(`Stored bytes: ${store.bytesStored}\n`);
        }
      }
    }
  }
  for (const sessionId of await pendingTraceSessions(input.cwd)) {
    stream.write(`Pending agent session: ${sessionId}\n`);
  }
  for (const failure of await listTraceSyncFailures(devHome)) {
    stream.write(
      `Failed background sync: session ${failure.session}${
        failure.repository ? ` of ${failure.repository}` : ""
      } at ${failure.at}: ${failure.error} Retry with \`${failure.retry}\`.\n`,
    );
  }
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
