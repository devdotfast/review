import crypto from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { type JsonValue, parseJsonText } from "@dev.fast/review-protocol";
import { init as initModuleLexer, parse as parseModule } from "es-module-lexer";
import { z } from "zod";

import {
  type NormalizedSoftwareModel,
  isNormalizedSoftwareModel,
} from "./software-map-model";

export const REVIEW_SOFTWARE_MAP_BUNDLE_DIR = path.join(
  ".bundle",
  "software-map",
);
const HEAD_MAP_FILE = "head-map.js";
const BASE_MAP_FILE = "base-map.js";
const MANIFEST_FILE = "manifest.json";
const MANIFEST_VERSION = 1;

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

const DocumentModuleSchema = z.object({ activeReviewDocument: z.unknown() });
const EvaluatedDocumentSchema = z.object({
  repoSoftwareMap: z.unknown(),
  baseSoftwareMap: z.unknown(),
});

const SoftwareMapBundleManifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  headCommit: z.string().regex(COMMIT_SHA_PATTERN),
  baseCommit: z.string().regex(COMMIT_SHA_PATTERN),
});

type SoftwareMapBundleManifest = z.infer<
  typeof SoftwareMapBundleManifestSchema
>;

export interface ReviewSoftwareMapBundle {
  headCode: string;
  baseCode: string;
  contentHash: string;
  headCommit: string;
  baseCommit: string;
}

export function bundleReviewSoftwareMap(input: {
  head: NormalizedSoftwareModel;
  base: NormalizedSoftwareModel;
  headCommit: string;
  baseCommit: string;
}): ReviewSoftwareMapBundle {
  const headCode = softwareMapModuleSource(input.head);
  const baseCode = softwareMapModuleSource(input.base);
  return {
    headCode,
    baseCode,
    contentHash: bundleHash(headCode, baseCode),
    headCommit: input.headCommit,
    baseCommit: input.baseCommit,
  };
}

export async function writeReviewSoftwareMapBundle(
  reviewDir: string,
  bundle: ReviewSoftwareMapBundle,
): Promise<void> {
  const bundleDir = path.join(reviewDir, REVIEW_SOFTWARE_MAP_BUNDLE_DIR);
  await mkdir(bundleDir, { recursive: true, mode: 0o700 });
  const manifest: SoftwareMapBundleManifest = {
    version: MANIFEST_VERSION,
    headCommit: bundle.headCommit,
    baseCommit: bundle.baseCommit,
  };
  await Promise.all([
    writeFile(path.join(bundleDir, HEAD_MAP_FILE), bundle.headCode, "utf8"),
    writeFile(path.join(bundleDir, BASE_MAP_FILE), bundle.baseCode, "utf8"),
    writeFile(
      path.join(bundleDir, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    ),
  ]);
}

export async function readReviewSoftwareMapBundle(
  rootDir: string,
): Promise<ReviewSoftwareMapBundle | null> {
  const bundleDir = path.join(rootDir, REVIEW_SOFTWARE_MAP_BUNDLE_DIR);
  let manifestRaw: string;
  let headCode: string;
  let baseCode: string;
  try {
    [manifestRaw, headCode, baseCode] = await Promise.all([
      readFile(path.join(bundleDir, MANIFEST_FILE), "utf8"),
      readFile(path.join(bundleDir, HEAD_MAP_FILE), "utf8"),
      readFile(path.join(bundleDir, BASE_MAP_FILE), "utf8"),
    ]);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const manifest = parseManifest(manifestRaw);
  if (!manifest) return null;
  return {
    headCode,
    baseCode,
    contentHash: bundleHash(headCode, baseCode),
    headCommit: manifest.headCommit,
    baseCommit: manifest.baseCommit,
  };
}

export function sameReviewSoftwareMapBundle(
  left: ReviewSoftwareMapBundle,
  right: ReviewSoftwareMapBundle,
): boolean {
  return (
    left.headCode === right.headCode &&
    left.baseCode === right.baseCode &&
    left.headCommit === right.headCommit &&
    left.baseCommit === right.baseCommit
  );
}

// The review-doc-runtime substitute a legacy bundle evaluates against lives
// in a pid-keyed global slot so concurrent migrations never share one.
interface LegacyMapMigrationGlobal<Runtime> {
  [slot: `__reviewLegacyMapMigration${number}`]: Runtime | undefined;
}

export async function extractLegacyReviewSoftwareMapBundle(input: {
  bundleCode: string;
  evaluationDir: string;
  headCommit: string;
  baseCommit: string;
}): Promise<ReviewSoftwareMapBundle | null> {
  const runtimeFile = "legacy-runtime.mjs";
  const documentFile = "legacy-document.mjs";
  const runtimeSpecifier = JSON.stringify("review-doc-runtime");
  if (!input.bundleCode.includes(runtimeSpecifier)) return null;
  await initModuleLexer;
  const [imports] = parseModule(input.bundleCode);
  const names = new Set([
    "createActiveReviewDocument",
    "createBrowserReviewDefinitionSession",
    "defineSoftwareModel",
    "setReviewRequestContext",
  ]);
  for (const record of imports) {
    if (record.n !== "review-doc-runtime" || record.d !== -1) continue;
    const statement = input.bundleCode.slice(record.ss, record.se);
    const named = /\{([\s\S]*?)\}/.exec(statement)?.[1] ?? "";
    for (const entry of named.split(",")) {
      const name = entry.split(/\s+as\s+/)[0]!.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  let captured: {
    repoSoftwareMap?: unknown;
    baseSoftwareMap?: unknown;
  } | null = null;
  const identity = <T>(value: T) => value;
  const session = {
    begin() {},
    async ready() {},
    diagnostics: [],
    defineActors: identity,
    defineAnchors: identity,
    defineStores: identity,
    defineSoftwareActors: <M, T>(_model: M, value: T): T => value,
    defineSoftwareStores: <M, T>(_model: M, value: T): T => value,
  };
  const runtime = {
    createActiveReviewDocument(value: typeof captured) {
      captured = value;
      return value;
    },
    createBrowserReviewDefinitionSession: () => session,
    defineSoftwareModel: identity,
    setReviewRequestContext() {},
    Fragment: Symbol("Fragment"),
    jsx: () => ({}),
    jsxs: () => ({}),
    jsxDEV: () => ({}),
    React: {},
  };
  const key: `__reviewLegacyMapMigration${number}` = `__reviewLegacyMapMigration${process.pid}`;
  // SAFETY: the slot is private to this module and namespaced by pid; it only
  // ever holds `runtime`, and the prior value is restored in `finally`.
  const holder = globalThis as LegacyMapMigrationGlobal<typeof runtime>;
  const prior = holder[key];
  holder[key] = runtime;
  try {
    await mkdir(input.evaluationDir, { recursive: true, mode: 0o700 });
    const runtimeSource = [
      `const runtime = globalThis[${JSON.stringify(key)}];`,
      `const get = (name) => runtime[name] ?? (() => undefined);`,
      ...[...names].map(
        (name) => `export const ${name} = get(${JSON.stringify(name)});`,
      ),
      "export default runtime.React;",
      "",
    ].join("\n");
    await Promise.all([
      writeFile(path.join(input.evaluationDir, runtimeFile), runtimeSource),
      writeFile(
        path.join(input.evaluationDir, documentFile),
        input.bundleCode
          .split(runtimeSpecifier)
          .join(JSON.stringify(`./${runtimeFile}`)),
      ),
    ]);
    const url = pathToFileURL(path.join(input.evaluationDir, documentFile));
    url.searchParams.set("t", String(Date.now()));
    const module: unknown = await import(url.href);
    const document = EvaluatedDocumentSchema.safeParse(
      DocumentModuleSchema.safeParse(module).data?.activeReviewDocument ??
        captured,
    ).data;
    if (
      !document ||
      !isNormalizedSoftwareModel(document.repoSoftwareMap) ||
      !isNormalizedSoftwareModel(document.baseSoftwareMap)
    ) {
      return null;
    }
    return bundleReviewSoftwareMap({
      head: document.repoSoftwareMap,
      base: document.baseSoftwareMap,
      headCommit: input.headCommit,
      baseCommit: input.baseCommit,
    });
  } finally {
    holder[key] = prior;
    await rm(input.evaluationDir, { recursive: true, force: true });
  }
}

function softwareMapModuleSource(model: NormalizedSoftwareModel): string {
  return [
    `const elements = Object.freeze(${JSON.stringify(model.elements)});`,
    `const relationships = Object.freeze(${JSON.stringify(model.relationships)});`,
    "const elementsByPath = new Map(elements.map((element) => [element.path, element]));",
    "export default Object.freeze({ elements, elementsByPath, relationships });",
    "",
  ].join("\n");
}

function bundleHash(headCode: string, baseCode: string): string {
  return crypto
    .createHash("sha256")
    .update(headCode)
    .update("\0")
    .update(baseCode)
    .digest("hex")
    .slice(0, 20);
}

function parseManifest(raw: string): SoftwareMapBundleManifest | null {
  let value: JsonValue;
  try {
    value = parseJsonText(raw);
  } catch {
    return null;
  }
  const manifest = SoftwareMapBundleManifestSchema.safeParse(value);
  return manifest.success ? manifest.data : null;
}
