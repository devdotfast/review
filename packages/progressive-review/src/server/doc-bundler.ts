import crypto from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type Message, type Plugin, build } from "esbuild";

import {
  type ReviewDocumentDiagnostic,
  compileReviewDocument,
  formatReviewDocumentDiagnostics,
} from "../compiler/review-document-compiler";
import { reviewDocumentRoutePathForFile } from "../review-paths";

const DOCUMENT_MODULE_ID = "review:document";
const ENTRY_MODULE_ID = "review:entry";
const VIRTUAL_NAMESPACE = "review-document";
const REVIEW_AUTHORING_MODULE_ID = "virtual:progressive-review-authoring";
export const REVIEW_DOC_RUNTIME_SPECIFIER = "review-doc-runtime";

interface ReviewDocumentManifest {
  slug: string;
  routePath: string;
  filePath: string;
  title: string;
  modelNames: string[];
  isDefault: boolean;
}

export interface ReviewDocumentBundle {
  code: string;
  contentHash: string;
  routePath: string;
  sourcePath: string;
}

export interface ReviewDocumentBundlerInput {
  reviewPath: string;
  reviewDocumentsDir: string;
  reviewRootPath: string;
  routePath: string;
}

export type ReviewDocumentValidationInput = ReviewDocumentBundlerInput;

export async function bundleReviewDocument(
  input: ReviewDocumentBundlerInput,
): Promise<ReviewDocumentBundle> {
  const result = await compileReviewDocumentBundle(input);
  if (!result.bundle) {
    throw new Error(formatReviewDocumentDiagnostics(result.diagnostics));
  }
  return result.bundle;
}

// The structured sibling of bundleReviewDocument: diagnostics come back as
// data instead of one formatted Error, so `review publish` can report each
// one on its own output line.
export async function compileReviewDocumentBundle(
  input: ReviewDocumentBundlerInput,
): Promise<{
  bundle: ReviewDocumentBundle | null;
  diagnostics: ReviewDocumentDiagnostic[];
}> {
  const result = await buildReviewDocument(input, "bundle");
  if (result.diagnostics.length > 0) {
    return { bundle: null, diagnostics: result.diagnostics };
  }
  if (!result.document || !result.code) {
    throw new Error("Review document bundler produced no ESM output.");
  }
  const contentHash = crypto
    .createHash("sha256")
    .update(result.code)
    .digest("hex")
    .slice(0, 20);
  return {
    diagnostics: [],
    bundle: {
      code: result.code,
      contentHash,
      routePath: result.document.routePath,
      sourcePath: result.document.filePath,
    },
  };
}

export async function validateReviewDocument(
  input: ReviewDocumentValidationInput,
): Promise<{ diagnostics: ReviewDocumentDiagnostic[] }> {
  const result = await buildReviewDocument(input, "validation");
  return { diagnostics: result.diagnostics };
}

async function buildReviewDocument(
  input: ReviewDocumentValidationInput | ReviewDocumentBundlerInput,
  mode: "bundle" | "validation",
): Promise<{
  code?: string;
  diagnostics: ReviewDocumentDiagnostic[];
  document?: ReviewDocumentManifest;
}> {
  const documents = await collectReviewDocumentManifests({
    reviewPath: input.reviewPath,
    reviewDocumentsDir: input.reviewDocumentsDir,
  });
  const document = documents.find(
    (candidate) => candidate.routePath === input.routePath,
  );
  if (!document) {
    throw new Error(`No Review document exists for route ${input.routePath}.`);
  }

  const source = await readFile(document.filePath, "utf8");
  const compilation = await compileReviewDocument({
    filePath: document.filePath,
    source,
    reviewRootPath: input.reviewRootPath,
  });
  const errors = compilation.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  );
  if (!compilation.runtimeCode || errors.length > 0) {
    return { diagnostics: errors };
  }

  let result;
  try {
    result = await build({
      absWorkingDir: input.reviewRootPath,
      bundle: true,
      format: "esm",
      minify: false,
      platform: "browser",
      plugins: [
        reviewDocumentPlugin({
          document,
          runtimeCode: compilation.runtimeCode,
          mode,
        }),
      ],
      sourcemap: mode === "bundle" ? "inline" : false,
      stdin: {
        contents:
          mode === "bundle"
            ? `export { activeReviewDocument } from ${JSON.stringify(ENTRY_MODULE_ID)};`
            : `import ${JSON.stringify(ENTRY_MODULE_ID)};`,
        loader: "js",
        resolveDir: input.reviewRootPath,
        sourcefile: "review-document-entry.js",
      },
      target: ["chrome120"],
      treeShaking: true,
      write: false,
    });
  } catch (error) {
    return { diagnostics: esbuildDiagnostics(error, document.filePath) };
  }
  const code =
    result.outputFiles.find((file) => file.path.endsWith(".js"))?.text ??
    result.outputFiles[0]?.text;
  return { code, diagnostics: [], document };
}

function reviewDocumentPlugin(input: {
  document: ReviewDocumentManifest;
  runtimeCode: string;
  mode: "bundle" | "validation";
}): Plugin {
  return {
    name: "progressive-review-document-bundle",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^review:entry$/ }, () => ({
        path: ENTRY_MODULE_ID,
        namespace: VIRTUAL_NAMESPACE,
      }));
      pluginBuild.onResolve({ filter: /^review:document$/ }, () => ({
        path: DOCUMENT_MODULE_ID,
        namespace: VIRTUAL_NAMESPACE,
      }));
      pluginBuild.onResolve(
        { filter: /^virtual:progressive-review-authoring$/ },
        () => ({
          path: REVIEW_AUTHORING_MODULE_ID,
          namespace: VIRTUAL_NAMESPACE,
        }),
      );
      pluginBuild.onResolve(
        { filter: /^(?:react|react\/jsx-runtime|react\/jsx-dev-runtime)$/ },
        () => ({ path: REVIEW_DOC_RUNTIME_SPECIFIER, external: true }),
      );
      pluginBuild.onResolve({ filter: /^review-doc-runtime$/ }, () => ({
        path: REVIEW_DOC_RUNTIME_SPECIFIER,
        external: true,
      }));
      pluginBuild.onResolve({ filter: /^file:/ }, ({ path: fileUrl }) => ({
        path: fileURLToPath(fileUrl),
      }));
      pluginBuild.onLoad(
        { filter: /.*/, namespace: VIRTUAL_NAMESPACE },
        ({ path: moduleId }) => {
          if (moduleId === DOCUMENT_MODULE_ID) {
            return {
              contents: input.runtimeCode,
              loader: "js",
              resolveDir: path.dirname(input.document.filePath),
            };
          }
          if (moduleId === REVIEW_AUTHORING_MODULE_ID) {
            return {
              contents:
                input.mode === "bundle"
                  ? authoringModuleSource({ document: input.document })
                  : validationAuthoringModuleSource(),
              loader: "js",
              resolveDir: path.dirname(input.document.filePath),
            };
          }
          return {
            contents:
              input.mode === "bundle"
                ? entryModuleSource(input)
                : validationEntryModuleSource(),
            loader: "js",
            resolveDir: path.dirname(input.document.filePath),
          };
        },
      );
    },
  };
}

function validationAuthoringModuleSource(): string {
  return [
    "const identity = (value) => value;",
    "export const calls = (parent, child, reason) =>",
    '  ({ __kind: "call-assertion", parent, child, reason });',
    "export const defineSoftwareModel = identity;",
    "export const defineActors = identity;",
    "export const defineAnchors = identity;",
    "export const defineStores = identity;",
    "export const defineSoftwareActors = identity;",
    "export const defineSoftwareStores = identity;",
    "export const __reviewDefinitionsReady = Promise.resolve();",
  ].join("\n");
}

function validationEntryModuleSource(): string {
  return `import ${JSON.stringify(DOCUMENT_MODULE_ID)};`;
}

// The generated authoring module names no origin and no token: the runtime
// receives the session's request context from the canvas at mount time, so
// one published bundle can be served from any origin.
function authoringModuleSource(input: {
  document: ReviewDocumentManifest;
}): string {
  return [
    `import { calls, createBrowserReviewDefinitionSession, defineSoftwareModel } from ${JSON.stringify(REVIEW_DOC_RUNTIME_SPECIFIER)};`,
    `const session = createBrowserReviewDefinitionSession({`,
    `  routePath: ${JSON.stringify(input.document.routePath)},`,
    `  softwareMap: null,`,
    `  baseSoftwareMap: null,`,
    `});`,
    `session.begin();`,
    `export { calls, defineSoftwareModel };`,
    `export const defineActors = session.defineActors;`,
    `export const defineAnchors = session.defineAnchors;`,
    `export const defineStores = session.defineStores;`,
    `export const defineSoftwareActors = session.defineSoftwareActors;`,
    `export const defineSoftwareStores = session.defineSoftwareStores;`,
    `export const __reviewDefinitionsReady = session.ready;`,
  ].join("\n");
}

function entryModuleSource(input: {
  document: ReviewDocumentManifest;
}): string {
  return [
    `import * as reviewDocumentModule from ${JSON.stringify(DOCUMENT_MODULE_ID)};`,
    `import { createActiveReviewDocument } from ${JSON.stringify(REVIEW_DOC_RUNTIME_SPECIFIER)};`,
    `export const activeReviewDocument = createActiveReviewDocument({`,
    `  slug: ${JSON.stringify(input.document.slug)},`,
    `  routePath: ${JSON.stringify(input.document.routePath)},`,
    `  filePath: ${JSON.stringify(input.document.filePath)},`,
    `  title: ${JSON.stringify(input.document.title)},`,
    `  modelNames: ${JSON.stringify(input.document.modelNames)},`,
    `  models: reviewDocumentModule,`,
    `  Component: reviewDocumentModule.default,`,
    `  isDefault: ${String(input.document.isDefault)},`,
    `});`,
  ].join("\n");
}

async function collectReviewDocumentManifests(input: {
  reviewPath: string;
  reviewDocumentsDir: string;
}): Promise<ReviewDocumentManifest[]> {
  const reviewPath = path.resolve(input.reviewPath);
  const reviewDocumentsDir = path.resolve(input.reviewDocumentsDir);
  const entries = await readdir(reviewDocumentsDir, {
    withFileTypes: true,
  }).catch(() => []);
  const discovered = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mdx"))
    .map((entry) => {
      const filePath = path.join(reviewDocumentsDir, entry.name);
      const routePath = reviewDocumentRoutePathForFile({
        reviewDocumentsDir,
        filePath,
      });
      if (!routePath) return null;
      return {
        slug: path.basename(entry.name, ".mdx"),
        routePath,
        filePath,
        titleFallback: path.basename(entry.name, ".mdx"),
        isDefault: false,
      };
    })
    .filter((document) => document !== null);
  const candidates = [
    {
      slug: "",
      routePath:
        reviewDocumentRoutePathForFile({
          reviewDocumentsDir,
          filePath: reviewPath,
        }) ?? "/",
      filePath: reviewPath,
      titleFallback: "review",
      isDefault: true,
    },
    ...discovered.filter(
      (document) => path.resolve(document.filePath) !== reviewPath,
    ),
  ].sort((left, right) => left.routePath.localeCompare(right.routePath));

  return Promise.all(
    candidates.map(async (document) => {
      const source = await readFile(document.filePath, "utf8").catch(() => "");
      return {
        slug: document.slug,
        routePath: document.routePath,
        filePath: document.filePath,
        title: reviewDocumentTitleFromSource(source, document.titleFallback),
        modelNames: reviewDocumentSoftwareModelNamesFromSource(source),
        isDefault: document.isDefault,
      };
    }),
  );
}

function reviewDocumentSoftwareModelNamesFromSource(source: string): string[] {
  const names: string[] = [];
  const pattern =
    /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*defineSoftwareModel\s*\(/g;
  let match;
  while ((match = pattern.exec(source))) names.push(match[1]);
  return names;
}

function reviewDocumentTitleFromSource(
  source: string,
  fallback: string,
): string {
  let inFence = false;
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const title = match[1].replace(/\s+#+\s*$/, "").trim();
    if (title) return title;
  }
  return fallback;
}

function esbuildDiagnostics(
  error: unknown,
  fallbackFilePath: string,
): ReviewDocumentDiagnostic[] {
  const messages =
    error && typeof error === "object" && "errors" in error
      ? (error.errors as Message[])
      : [];
  if (messages.length === 0) {
    return [
      {
        source: "review",
        severity: "error",
        code: "bundle",
        message: error instanceof Error ? error.message : String(error),
        filePath: fallbackFilePath,
      },
    ];
  }
  return messages.map((message) => ({
    source: "review",
    severity: "error",
    code: "bundle",
    message: message.text,
    filePath: message.location?.file ?? fallbackFilePath,
    ...(message.location?.line ? { line: message.location.line } : {}),
    ...(message.location?.column
      ? { column: message.location.column + 1 }
      : {}),
  }));
}
