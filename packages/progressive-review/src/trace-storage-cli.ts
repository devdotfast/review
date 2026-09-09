import os from "node:os";

import {
  type CliJsonOutput,
  emitJsonEvent,
  failWithJsonError,
  humanStream,
} from "./cli-output";
import { clearTraceEnvCache } from "./review-agent-traces";
import { devReviewHome } from "./review-storage";
import { DEFAULT_STORE_ORIGIN, readStoreAuth } from "./store-auth";
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
  type DirectCaptureSettings,
  type DirectProfile,
  type TraceConfig,
  TraceConfigurationError,
  directProfileSchema,
  readTraceConfigFile,
  sameDirectProfile,
  writeTraceConfigFile,
} from "./trace-storage/config";
import { DirectTraceStorage } from "./trace-storage/direct";
import {
  DIRECT_DEFAULT_REGION,
  type DirectCredentials,
  isDirectMockMode,
  resolveDirectSetup,
  traceSettingsPath,
} from "./trace-storage/direct-config";
import {
  type TraceStorageSelection,
  selectTraceStorage,
} from "./trace-storage/resolve";
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
  if (input.mode !== "direct") {
    return failWithJsonError(
      input,
      stage,
      `Unknown storage mode "${input.mode}". Use "direct" or "hosted".`,
    );
  }

  try {
    const configFile = readTraceConfigFile(scope);
    if (configFile.error) throw new TraceConfigurationError(configFile.error);
    const current = configFile.config ?? { version: 2 as const };
    const flags = [input.endpoint, input.bucket, input.key, input.secret];
    let next: TraceConfig;
    if (flags.some(Boolean)) {
      if (!flags.every(Boolean)) {
        throw new TraceConfigurationError(
          "Direct storage needs --endpoint, --bucket, --key, and --secret together.",
        );
      }
      const profile = directProfileSchema.parse({
        endpoint: input.endpoint,
        bucket: input.bucket,
        accessKeyId: input.key,
        secretAccessKey: input.secret,
        region:
          input.region?.trim() ||
          current.direct?.region ||
          DIRECT_DEFAULT_REGION,
        capture: current.direct?.capture ?? {
          enabled: true,
          autoActivateRepositories: true,
        },
      });
      await requireReachable(profile, scope);
      next = { ...current, storage: { mode: "direct" }, direct: profile };
    } else {
      const setup = resolveDirectSetup(scope);
      if (!setup.credentials && !isDirectMockMode(scope.env)) {
        throw new TraceConfigurationError(
          "No S3/R2 credentials are configured. Pass --endpoint, --bucket, --key, and --secret, or use Review Agent Setup.",
        );
      }
      next = { ...current, storage: { mode: "direct" } };
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
      mode: "direct",
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
      input.origin ?? auth?.origin ?? DEFAULT_STORE_ORIGIN,
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
    const current = configFile.config ?? { version: 2 as const };
    await writeTraceConfigFile(configFile, {
      ...current,
      storage: { mode: "hosted", origin },
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
        .filter((entry) => entry.store === origin)
        .map((entry) => entry.name)
        .join(", ")}\n`,
    );
    if (selectTraceStorage(scope).direct?.credentials) {
      human.write(
        "Bucket credentials stay saved and inactive; `review trace storage use direct` switches back.\n",
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
    const legacy = resolveDirectSetup({ ...scope, ignoreProfile: true });
    if (!legacy.credentials) {
      throw new TraceConfigurationError(
        `No legacy S3/R2 configuration to migrate (checked ${legacy.envPath} and the environment).`,
      );
    }
    const settingsPath = traceSettingsPath(scope.homeDir, scope.env);
    const settings = await readLegacyCaptureSettings(settingsPath);

    // 2. The candidate profile and explicit selection. Disabled or absent
    // capture settings stay disabled; migration never enables capture.
    const capture: DirectCaptureSettings = {
      enabled: settings?.enabled === true,
      autoActivateRepositories:
        settings?.enabled === true &&
        settings.autoActivateRepositories === true,
    };
    if (settings?.verifiedAt) capture.verifiedAt = settings.verifiedAt;
    const candidate = directProfileSchema.parse({
      ...legacy.credentials,
      capture,
    });
    const configFile = readTraceConfigFile(scope);
    if (configFile.error) throw new TraceConfigurationError(configFile.error);
    const current = configFile.config ?? { version: 2 as const };
    if (current.storage?.mode === "hosted") {
      throw new TraceConfigurationError(
        `Hosted storage is selected in ${configFile.path}. Run \`review trace storage use direct\` first; migration never switches destinations.`,
      );
    }
    const unchanged =
      current.direct !== undefined &&
      sameDirectProfile(current.direct, candidate);
    if (current.direct && !unchanged) {
      throw new TraceConfigurationError(
        `${configFile.path} already holds a different direct profile. Remove it or update it with \`review trace storage use direct --endpoint ...\`; migration does not overwrite it.`,
      );
    }

    human.write(
      `${input.dryRun ? "Previewing" : "Migrating"} direct trace configuration into ${configFile.path}\n`,
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
      `  Destination: ${candidate.endpoint} bucket "${candidate.bucket}" region ${candidate.region ?? DIRECT_DEFAULT_REGION}, key ${candidate.accessKeyId.slice(0, 6)}…\n`,
    );

    // 3. Validate independently of overrides and check reachability.
    await requireReachable(candidate, scope);
    human.write("  Reachability: ok\n");

    let status: "unchanged" | "written" | "preview";
    if (unchanged && current.storage?.mode === "direct") {
      status = "unchanged";
      human.write("Nothing to do: the config already holds this profile.\n");
    } else if (input.dryRun) {
      status = "preview";
      human.write("Dry run: nothing was written.\n");
    } else {
      // 4. Atomic private write; concurrent edits are refused.
      await writeTraceConfigFile(configFile, {
        ...current,
        storage: { mode: "direct" },
        direct: candidate,
      });
      clearTraceEnvCache();
      status = "written";
      human.write(`Wrote ${configFile.path} (mode 0600).\n`);
    }
    // 5. Legacy inputs stay as they are.
    human.write(
      "Legacy env and settings files were left unchanged; exported TRACE_R2_* variables still take precedence. Removing them is optional.\n",
    );
    emitJsonEvent(input, {
      event: stage,
      status,
      dryRun: Boolean(input.dryRun),
      configPath: configFile.path,
      credentialsSource: legacy.source,
      overrides: legacy.overrides,
      settingsPath,
      endpoint: candidate.endpoint,
      bucket: candidate.bucket,
      region: candidate.region ?? DIRECT_DEFAULT_REGION,
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
  const setup = selection.direct;
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
  return `direct S3/R2 ${where} (${selection.explicit ? "selected" : "legacy configuration"}; credentials from ${source}${overrides})`;
}

async function requireReachable(
  profile: DirectProfile,
  scope: TraceStorageCommandScope,
): Promise<void> {
  const env = scope.env ?? process.env;
  if (isDirectMockMode(env)) return;
  const credentials: DirectCredentials = {
    endpoint: profile.endpoint,
    bucket: profile.bucket,
    accessKeyId: profile.accessKeyId,
    secretAccessKey: profile.secretAccessKey,
    region: profile.region ?? DIRECT_DEFAULT_REGION,
  };
  const doctor = await DirectTraceStorage.fromCredentials(
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
