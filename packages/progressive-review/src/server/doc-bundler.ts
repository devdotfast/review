import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type BuildFailure, type Plugin, build } from "esbuild";

import {
  type ReviewDocumentDiagnostic,
  compileReviewDocument,
  formatReviewDocumentDiagnostics,
} from "../compiler/review-document-compiler";
import { collectReviewDocumentScanForRuntime } from "../compiler/review-documents-module";
import { REVIEW_AUTHORING_MODULE_ID } from "../compiler/review-documents-module";

const DOCUMENT_MODULE_ID = "review:document";
const ENTRY_MODULE_ID = "review:entry";
const VIRTUAL_NAMESPACE = "review-document";
export const REVIEW_DOC_RUNTIME_SPECIFIER = "review-doc-runtime";

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
  const result = await buildReviewDocument(input);
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

async function buildReviewDocument(input: ReviewDocumentBundlerInput): Promise<{
  code?: string;
  diagnostics: ReviewDocumentDiagnostic[];
  document?: Awaited<
    ReturnType<typeof collectReviewDocumentScanForRuntime>
  >["manifests"][number];
}> {
  const scan = await collectReviewDocumentScanForRuntime({
    reviewPath: input.reviewPath,
    reviewDocumentsDir: input.reviewDocumentsDir,
    reviewRootPath: input.reviewRootPath,
  });
  const document = scan.manifests.find(
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
        }),
      ],
      sourcemap: "inline",
      stdin: {
        contents: `export { activeReviewDocument } from ${JSON.stringify(ENTRY_MODULE_ID)};`,
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
  document: Awaited<
    ReturnType<typeof collectReviewDocumentScanForRuntime>
  >["manifests"][number];
  runtimeCode: string;
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
              contents: authoringModuleSource({ document: input.document }),
              loader: "js",
              resolveDir: path.dirname(input.document.filePath),
            };
          }
          return {
            contents: entryModuleSource(input),
            loader: "js",
            resolveDir: path.dirname(input.document.filePath),
          };
        },
      );
    },
  };
}

// The generated authoring module names no origin and no token: the runtime
// receives the session's request context from the canvas at mount time, so
// one published bundle can be served from any origin.
function authoringModuleSource(input: {
  document: Awaited<
    ReturnType<typeof collectReviewDocumentScanForRuntime>
  >["manifests"][number];
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
  document: Awaited<
    ReturnType<typeof collectReviewDocumentScanForRuntime>
  >["manifests"][number];
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

function isBuildFailure(cause: unknown): cause is BuildFailure {
  return (
    cause instanceof Error && "errors" in cause && Array.isArray(cause.errors)
  );
}

function esbuildDiagnostics(
  cause: unknown,
  fallbackFilePath: string,
): ReviewDocumentDiagnostic[] {
  const messages = isBuildFailure(cause) ? cause.errors : [];
  if (messages.length === 0) {
    return [
      {
        source: "review",
        severity: "error",
        code: "bundle",
        message: cause instanceof Error ? cause.message : String(cause),
        filePath: fallbackFilePath,
      },
    ];
  }
  return messages.map((message) => {
    const diagnostic: ReviewDocumentDiagnostic = {
      source: "review",
      severity: "error",
      code: "bundle",
      message: message.text,
      filePath: message.location?.file ?? fallbackFilePath,
    };
    if (message.location?.line) diagnostic.line = message.location.line;
    if (message.location?.column) {
      diagnostic.column = message.location.column + 1;
    }
    return diagnostic;
  });
}
