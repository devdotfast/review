import { existsSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type CliJsonOutput,
  emitJsonEvent,
  failWithJsonError,
  humanStream,
} from "./cli-output";
import { clearTraceEnvCache } from "./review-agent-traces";
import { devReviewHome } from "./review-storage";
import { readStoreAuth } from "./store-auth";
import { StoreApiError, StoreClient } from "./store-client";
import { normalizeStoreOrigin } from "./store-origin";
import {
  readLegacyCaptureSettings,
  traceMachineStatus,
} from "./trace-machine-setup";
import { traceRepositoryStatus } from "./trace-repository-hooks";
import {
  type TraceRepositoryTarget,
  requireTraceConsent,
  resolveTraceRepositoryTarget,
} from "./trace-repository-target";
import {
  DEFAULT_HOSTED_ORIGIN,
  type S3CaptureSettings,
  type S3Profile,
  type TraceConfig,
  TraceConfigurationError,
  currentStore,
  emptyTraceConfig,
  readTraceConfigFile,
  s3ProfileSchema,
  s3Store,
  sameS3Profile,
  writeTraceConfigFile,
} from "./trace-storage/config";
import {
  type TraceStorageSelection,
  selectTraceStorage,
} from "./trace-storage/resolve";
import { S3TraceStorage } from "./trace-storage/s3";
import {
  type S3Credentials,
  S3_DEFAULT_REGION,
  isS3MockMode,
  resolveS3Setup,
  traceSettingsPath,
} from "./trace-storage/s3-config";
import { readTraceUserConfig } from "./trace-user-config";

/**
 * `review trace storage use` and `review trace config migrate`: the explicit
 * selection and configuration commands. Both write only
 * `$DEV_REVIEW_HOME/trace/config.json`; the legacy files, environment, and
 * every remote object stay as they are.
 */

interface TraceStorageCommandScope {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunReviewTraceStorageUseInput
  extends CliJsonOutput, TraceStorageCommandScope {
  cwd: string;
  mode: string;
  origin?: string;
  /** The hosted API client; tests inject one that answers locally. */
  client?: StoreClient;
  endpoint?: string;
  bucket?: string;
  key?: string;
  secret?: string;
  region?: string;
}

export async function runReviewTraceStorageUse(
  input: RunReviewTraceStorageUseInput,
): Promise<number> {
  const stage = "trace.storage.use";
  const scope = commandScope(input);
  if (input.mode === "hosted") return useHosted(input, scope, stage);
  if (input.mode !== "s3") {
    return failWithJsonError(
      input,
      stage,
      `Unknown storage mode "${input.mode}". Use "s3" or "hosted".`,
    );
  }

  try {
    const configFile = readTraceConfigFile(scope);
    if (configFile.error) throw new TraceConfigurationError(configFile.error);
    const current = configFile.config ?? emptyTraceConfig();
    const flags = [input.endpoint, input.bucket, input.key, input.secret];
    let next: TraceConfig;
    if (flags.some(Boolean)) {
      if (!flags.every(Boolean)) {
        throw new TraceConfigurationError(
          "Direct storage needs --endpoint, --bucket, --key, and --secret together.",
        );
      }
      const profile = s3ProfileSchema.parse({
        endpoint: input.endpoint,
        bucket: input.bucket,
        accessKeyId: input.key,
        secretAccessKey: input.secret,
        region:
          input.region?.trim() ||
          current.stores?.s3?.region ||
          S3_DEFAULT_REGION,
        capture: current.stores?.s3?.capture ?? {
          enabled: true,
          autoActivateRepositories: true,
        },
      });
      await requireReachable(profile, scope);
      next = {
        ...current,
        "current-store": "s3",
        stores: { ...current.stores, s3: profile },
      };
    } else {
      const setup = resolveS3Setup(scope);
      if (!setup.credentials && !isS3MockMode(scope.env)) {
        throw new TraceConfigurationError(
          "No S3/R2 credentials are configured. Pass --endpoint, --bucket, --key, and --secret, or use Review Agent Setup.",
        );
      }
      next = { ...current, "current-store": "s3" };
    }
    await writeTraceConfigFile(configFile, next);
    clearTraceEnvCache();

    const selection = selectTraceStorage(scope);
    const machine = await traceMachineStatus(scope);
    const repository = await traceRepositoryStatus(input.cwd);
    const human = humanStream(input);
    human.write(`Storage: ${describeSelection(selection)}\n`);
    human.write(`Capture: ${machine.enabled ? "enabled" : "disabled"}\n`);
    human.write(`Repository: ${repository.message}\n`);
    emitJsonEvent(input, {
      event: stage,
      mode: "s3",
      configPath: configFile.path,
      endpoint: machine.endpoint ?? null,
      bucket: machine.bucket ?? null,
      region: machine.region ?? null,
      captureEnabled: machine.enabled,
      repository: repository.message,
    });
    return 0;
  } catch (error) {
    return failWithJsonError(
      input,
      stage,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Selecting hosted storage validates everything a publication needs: a
 * login for the origin, a store that answers the revised contract, and
 * consent for this checkout's repository at that origin. Only then is the
 * selection persisted. Bucket credentials stay where they are, inert.
 */
async function useHosted(
  input: RunReviewTraceStorageUseInput,
  scope: { homeDir: string; env: NodeJS.ProcessEnv },
  stage: string,
): Promise<number> {
  try {
    const auth = await readStoreAuth(scope.env);
    const origin = normalizeStoreOrigin(
      input.origin ?? auth?.origin ?? DEFAULT_HOSTED_ORIGIN,
    );
    if (!auth || auth.origin !== origin) {
      throw new TraceConfigurationError(
        `Log in to ${origin} first: \`review login --origin ${origin}\`.`,
      );
    }
    const devHome = devReviewHome(scope.env, scope.homeDir);
    const client =
      input.client ?? new StoreClient({ origin, token: auth.token });
    let target: TraceRepositoryTarget;
    try {
      ({ target } = await resolveTraceRepositoryTarget({
        cwd: input.cwd,
        origin,
        client,
        write: true,
        devHome,
      }));
    } catch (error) {
      if (error instanceof StoreApiError && error.code === "upgrade_required") {
        throw new TraceConfigurationError(
          `${origin} does not serve the trace store contract this Review needs. Hosted storage was not selected.`,
        );
      }
      throw error;
    }
    const consent = await requireTraceConsent(target, devHome);

    const configFile = readTraceConfigFile(scope);
    if (configFile.error) throw new TraceConfigurationError(configFile.error);
    const current = configFile.config ?? emptyTraceConfig();
    // The default origin needs no entry; any other origin is written down.
    const stores = { ...current.stores };
    if (origin === DEFAULT_HOSTED_ORIGIN) delete stores.hosted;
    else stores.hosted = { origin };
    await writeTraceConfigFile(configFile, {
      ...current,
      "current-store": "hosted",
      stores,
    });
    clearTraceEnvCache();

    const config = await readTraceUserConfig(devHome);
    const human = humanStream(input);
    human.write(`Storage: hosted (${origin})\n`);
    human.write(
      `Destination: ${target.name} (repository ${target.repositoryId}, store ${target.storeId})\n`,
    );
    human.write(
      `Publication scope: ${config.repositories
        .filter((entry) => entry.enabledOrigins.includes(origin))
        .map((entry) => entry.name)
        .join(", ")}\n`,
    );
    if (selectTraceStorage(scope).s3?.credentials) {
      human.write(
        "Bucket credentials stay saved and inactive; `review trace storage use s3` switches back.\n",
      );
    }
    emitJsonEvent(input, {
      event: stage,
      mode: "hosted",
      configPath: configFile.path,
      origin,
      repositoryId: target.repositoryId,
      storeId: target.storeId,
      name: target.name,
      allowedAt: consent.allowedAt,
    });
    return 0;
  } catch (error) {
    return failWithJsonError(
      input,
      stage,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export interface RunReviewTraceConfigMigrateInput
  extends CliJsonOutput, TraceStorageCommandScope {
  dryRun?: boolean;
  /** Leave the legacy env and settings files in place after migrating. */
  keepLegacy?: boolean;
}

/** Where a migrated legacy file goes: `legacy_<name>` beside the original. */
export function legacyRetiredPath(filePath: string): string {
  return path.join(path.dirname(filePath), `legacy_${path.basename(filePath)}`);
}

/**
 * Copies the effective legacy bucket setup into the version-2 config.
 * Configuration moves; bucket objects, paths, and formats do not.
 */
export async function runReviewTraceConfigMigrate(
  input: RunReviewTraceConfigMigrateInput,
): Promise<number> {
  const stage = "trace.config.migrate";
  const scope = commandScope(input);
  const human = humanStream(input);
  try {
    // 1. The effective legacy inputs, overrides and custom paths included.
    const legacy = resolveS3Setup({ ...scope, ignoreProfile: true });
    if (!legacy.credentials) {
      throw new TraceConfigurationError(
        `No legacy S3/R2 configuration to migrate (checked ${legacy.envPath} and the environment).`,
      );
    }
    const settingsPath = traceSettingsPath(scope.homeDir, scope.env);
    const settings = await readLegacyCaptureSettings(settingsPath);

    // 2. The candidate profile and explicit selection. Disabled or absent
    // capture settings stay disabled; migration never enables capture.
    const capture: S3CaptureSettings = {
      enabled: settings?.enabled === true,
      autoActivateRepositories:
        settings?.enabled === true &&
        settings.autoActivateRepositories === true,
    };
    if (settings?.verifiedAt) capture.verifiedAt = settings.verifiedAt;
    const candidate = s3ProfileSchema.parse({
      ...legacy.credentials,
      capture,
    });
    const configFile = readTraceConfigFile(scope);
    if (configFile.error) throw new TraceConfigurationError(configFile.error);
    const current = configFile.config ?? emptyTraceConfig();
    if (currentStore(current) === "hosted") {
      throw new TraceConfigurationError(
        `Hosted storage is selected in ${configFile.path}. Run \`review trace storage use s3\` first; migration never switches destinations.`,
      );
    }
    const existingProfile = s3Store(current);
    const unchanged =
      existingProfile !== null && sameS3Profile(existingProfile, candidate);
    if (existingProfile && !unchanged) {
      throw new TraceConfigurationError(
        `${configFile.path} already holds a different direct profile. Remove it or update it with \`review trace storage use s3 --endpoint ...\`; migration does not overwrite it.`,
      );
    }

    human.write(
      `${input.dryRun ? "Previewing" : "Migrating"} S3 trace configuration into ${configFile.path}\n`,
    );
    human.write(
      `  Credentials: ${legacy.source === "process-env" ? "process environment" : legacy.envPath}${
        legacy.overrides.length > 0 && legacy.source !== "process-env"
          ? ` (environment overrides: ${legacy.overrides.join(", ")})`
          : ""
      }\n`,
    );
    human.write(
      `  Capture: ${candidate.capture?.enabled ? "enabled" : "disabled"} (from ${settingsPath})\n`,
    );
    human.write(
      `  Destination: ${candidate.endpoint} bucket "${candidate.bucket}" region ${candidate.region ?? S3_DEFAULT_REGION}, key ${candidate.accessKeyId.slice(0, 6)}…\n`,
    );

    // 3. Validate independently of overrides and check reachability.
    await requireReachable(candidate, scope);
    human.write("  Reachability: ok\n");

    let status: "unchanged" | "written" | "preview";
    if (unchanged && currentStore(current) === "s3") {
      status = "unchanged";
      human.write("Nothing to do: the config already holds this profile.\n");
    } else if (input.dryRun) {
      status = "preview";
      human.write("Dry run: nothing was written.\n");
    } else {
      // 4. Atomic private write; concurrent edits are refused.
      await writeTraceConfigFile(configFile, {
        ...current,
        "current-store": "s3",
        stores: { ...current.stores, s3: candidate },
      });
      clearTraceEnvCache();
      status = "written";
      human.write(`Wrote ${configFile.path} (mode 0600).\n`);
    }
    // 5. The legacy files are retired beside their originals so the new
    //    file is the only active source. Renaming, not deleting, keeps the
    //    rollback a rename away. Exported variables are the user's own.
    const retired: Array<{ from: string; to: string }> = [];
    if (status !== "preview" && !input.keepLegacy) {
      for (const filePath of [legacy.envPath, settingsPath]) {
        if (!existsSync(filePath)) continue;
        const to = legacyRetiredPath(filePath);
        renameSync(filePath, to);
        retired.push({ from: filePath, to });
      }
      clearTraceEnvCache();
    }
    if (retired.length > 0) {
      for (const move of retired) {
        human.write(`Retired ${move.from} -> ${move.to}\n`);
      }
      human.write(
        `To roll back, rename the retired files back and delete ${configFile.path}. Exported TRACE_R2_* variables still take precedence.\n`,
      );
    } else {
      human.write(
        "Legacy env and settings files were left unchanged; exported TRACE_R2_* variables still take precedence.\n",
      );
    }
    emitJsonEvent(input, {
      event: stage,
      status,
      dryRun: Boolean(input.dryRun),
      retired,
      configPath: configFile.path,
      credentialsSource: legacy.source,
      overrides: legacy.overrides,
      settingsPath,
      endpoint: candidate.endpoint,
      bucket: candidate.bucket,
      region: candidate.region ?? S3_DEFAULT_REGION,
      accessKeyIdPrefix: candidate.accessKeyId.slice(0, 6),
      capture: candidate.capture ?? null,
    });
    return 0;
  } catch (error) {
    return failWithJsonError(
      input,
      stage,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function describeSelection(selection: TraceStorageSelection): string {
  if (selection.error) return `error (${selection.error})`;
  if (selection.mode === "hosted") {
    return `hosted (${selection.hosted?.origin ?? "unknown origin"})`;
  }
  if (selection.mode === "none") return "none configured";
  const setup = selection.s3;
  const credentials = setup?.credentials;
  const where = credentials
    ? `bucket "${credentials.bucket}" at ${credentials.endpoint}`
    : "mock bucket";
  const source =
    setup?.source === "profile"
      ? "config.json profile"
      : setup?.source === "legacy-file"
        ? `legacy env file ${setup.envPath}`
        : setup?.source === "process-env"
          ? "process environment"
          : "test mode";
  const overrides =
    setup && setup.overrides.length > 0 && setup.source !== "process-env"
      ? `; environment overrides: ${setup.overrides.join(", ")}`
      : "";
  return `S3/R2 ${where} (${selection.explicit ? "selected" : "legacy configuration"}; credentials from ${source}${overrides})`;
}

async function requireReachable(
  profile: S3Profile,
  scope: TraceStorageCommandScope,
): Promise<void> {
  const env = scope.env ?? process.env;
  if (isS3MockMode(env)) return;
  const credentials: S3Credentials = {
    endpoint: profile.endpoint,
    bucket: profile.bucket,
    accessKeyId: profile.accessKeyId,
    secretAccessKey: profile.secretAccessKey,
    region: profile.region ?? S3_DEFAULT_REGION,
  };
  const doctor = await S3TraceStorage.fromCredentials(
    credentials,
    env,
  ).doctor();
  if (!doctor.reachable) {
    throw new TraceConfigurationError(
      `Cannot reach S3/R2 bucket "${profile.bucket}": ${doctor.error ?? "unknown error"}. Nothing was written; retry when the bucket is reachable.`,
    );
  }
}

function commandScope(scope: TraceStorageCommandScope) {
  return {
    homeDir: scope.homeDir ?? os.homedir(),
    env: scope.env ?? process.env,
  };
}
