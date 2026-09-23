import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { errorMessage } from "@dev.fast/trace-core";
import { init as initModuleLexer, parse as parseModule } from "es-module-lexer";

import type { StoreRef } from "./authoring";
import { span } from "./startup-trace";
import {
  type PublishValidationRuntime,
  type WhiteboardPublishEvaluationInput,
  type WhiteboardPublishEvaluationResult,
  evaluateWhiteboardDocumentForPublish,
} from "./whiteboard-publication-audit";
import {
  type PublishValidationProps,
  isPublishAuditComponent,
} from "./whiteboard-publish-element-audit";

export type {
  WhiteboardPublishEvidenceTargets,
  WhiteboardPublishEvaluationInput,
  WhiteboardPublishEvaluationResult,
  WhiteboardPublishRangePeek,
  WhiteboardPublishSourceTarget,
} from "./whiteboard-publication-audit";

// Bundle-loading adapter. Keep exact sealed legacy evaluation and its global
// runtime serialization here; evidence auditing and JSON materialization live
// in review-publication-audit so native authoring does not import this loader.
const RUNTIME_GLOBAL = "__devFastWhiteboardPublishRuntime";

const RUNTIME_SPECIFIER = "review-doc-runtime";

const RUNTIME_MODULE_FILE = "review-doc-runtime.mjs";

const DOCUMENT_MODULE_FILE = "whiteboard-document.mjs";

let evaluationQueue: Promise<unknown> = Promise.resolve();

/** The runtime lives on a process global while the bundle imports, so two
 * evaluations in one process must not overlap. The CLI evaluates once; the
 * desktop server evaluates on every legacy read. */
function serializeEvaluation<T>(run: () => Promise<T>): Promise<T> {
  const next = evaluationQueue.then(run, run);
  evaluationQueue = next.catch(() => undefined);

  return next;
}

// The generated runtime module reads its exports from this global slot: the
// evaluation installs the runtime before importing the document and restores
// whatever the slot held afterwards.
interface PublishValidationRuntimeGlobal {
  [RUNTIME_GLOBAL]?: PublishValidationRuntime;
}

// The stub module must declare every name the bundle imports from the runtime
// (ESM checks named imports at link time), so the export list is derived from
// the bundle's own import statements instead of mirroring doc-runtime.ts by
// hand. The four review exports always ship because the generated authoring
// module calls them at module scope.
const REQUIRED_EXPORT_NAMES = [
  "defineSoftwareModel",
  "createBrowserWhiteboardDefinitionSession",
  "createActiveWhiteboardDocument",
  "setWhiteboardRequestContext",
] as const;

export async function evaluateWhiteboardDocumentBundleForPublish(
  input: WhiteboardPublishEvaluationInput & {
    bundleCode: string;
    whiteboardDir: string;
  },
): Promise<WhiteboardPublishEvaluationResult> {
  return evaluateWhiteboardDocumentForPublish(input, (runtime) =>
    loadSealedWhiteboardDocument(input, {
      ...runtime,
      createActiveWhiteboardDocument: (document) => {
        const Component = document.Component;

        if (!isPublishAuditComponent(Component))
          return runtime.createActiveWhiteboardDocument(document);

        return runtime.createActiveWhiteboardDocument({
          ...document,
          Component: (props: PublishValidationProps) =>
            Component({
              ...props,
              components: {
                ...props.components,
                ReviewSection: props.components!.WhiteboardSection!,
              },
            }),
        });
      },
      createBrowserWhiteboardDefinitionSession: (options) => {
        const session =
          runtime.createBrowserWhiteboardDefinitionSession(options);

        return {
          ...session,
          defineStores: (stores) =>
            legacyStoreFields(session.defineStores(stores)),
          defineSoftwareStores: (model, stores) =>
            legacyStoreFields(session.defineSoftwareStores(model, stores)),
        };
      },
    }),
  );
}

/** Only sealed legacy bundles can use the former collection.fields accessor.
 * Keep direct fields and symbol-backed targets intact, including a real field
 * named "fields". Native authoring never receives these handles. */
function legacyStoreFields<T extends Record<string, StoreRef>>(stores: T): T {
  // SAFETY: these keys come from the same generic store map being indexed.
  for (const key of Object.keys(stores) as (keyof T)[]) {
    const store = { ...stores[key]! };

    for (const kind of ["tables", "documents"] as const) {
      const collections = store[kind];

      if (!collections) continue;
      store[kind] = Object.fromEntries(
        Object.entries(collections).map(([id, collection]) => [
          id,
          "fields" in collection
            ? collection
            : Object.freeze(
                Object.defineProperty(
                  Object.create(
                    Object.getPrototypeOf(collection),
                    Object.getOwnPropertyDescriptors(collection),
                  ),
                  "fields",
                  { value: collection },
                ),
              ),
        ]),
      );
    }

    stores[key] = store;
  }

  return stores;
}

function rewriteRuntimeSpecifier(bundleCode: string): string {
  const specifier = JSON.stringify(RUNTIME_SPECIFIER);

  if (!bundleCode.includes(specifier)) {
    throw new Error("Session document bundle has no runtime import.");
  }

  return bundleCode
    .split(specifier)
    .join(JSON.stringify(`./${RUNTIME_MODULE_FILE}`));
}

async function collectRuntimeImportNames(
  bundleCode: string,
): Promise<string[]> {
  await initModuleLexer;
  const [imports] = parseModule(bundleCode);
  const names = new Set<string>(REQUIRED_EXPORT_NAMES);

  for (const record of imports) {
    if (record.n !== RUNTIME_SPECIFIER || record.d !== -1) continue;
    const statement = bundleCode.slice(record.ss, record.se);
    const clause = /^import\b([\s\S]*?)\bfrom\b/.exec(statement)?.[1];

    if (!clause) continue;
    const named = /\{([\s\S]*?)\}/.exec(clause)?.[1] ?? "";

    for (const entry of named.split(",")) {
      const name = entry.split(/\s+as\s+/)[0]!.trim();

      // `default` binds through `export default`; anything else must be a
      // plain identifier to be re-exportable as `export const <name>`.
      if (/^[A-Za-z_$][\w$]*$/.test(name) && name !== "default") {
        names.add(name);
      }
    }
    // A namespace import needs no declared names, and a default import binds
    // the stub's `export default`; only named entries add to the list.
  }

  return [...names];
}

function validationRuntimeModuleSource(exportNames: readonly string[]): string {
  // Immutable MDX bundles import the original runtime export names. Translate
  // those only in the sealed-document loader, never in current authoring.
  const historicalExports = new Map([
    [
      "createBrowserReviewDefinitionSession",
      "createBrowserWhiteboardDefinitionSession",
    ],
    ["createActiveReviewDocument", "createActiveWhiteboardDocument"],
    ["setReviewRequestContext", "setWhiteboardRequestContext"],
    ["ReviewSection", "WhiteboardSection"],
  ]);

  return [
    `const runtime = globalThis.${RUNTIME_GLOBAL};`,
    `if (!runtime) {`,
    `  throw new Error("Whiteboard publish validation runtime is not installed.");`,
    `}`,
    // Names the curated runtime does not know become inert functions, so a new
    // doc-runtime export never fails the link or a module-scope call.
    `const get = (name) => (name in runtime ? runtime[name] : () => undefined);`,
    ...exportNames.map(
      (name) =>
        `export const ${name} = get(${JSON.stringify(historicalExports.get(name) ?? name)});`,
    ),
    `export default runtime.React;`,
    ``,
  ].join("\n");
}

async function loadSealedWhiteboardDocument(
  input: { bundleCode: string; whiteboardDir: string },
  runtime: PublishValidationRuntime,
): Promise<string | null> {
  const evaluationDir = path.join(
    input.whiteboardDir,
    ".build",
    `publish-validate-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );

  const runtimeImportNames = await collectRuntimeImportNames(input.bundleCode);
  // Validate both sources before starting either write. A synchronous rewrite
  // failure must not leave a write running outside Promise.all during cleanup.
  const runtimeSource = validationRuntimeModuleSource(runtimeImportNames);
  const documentSource = rewriteRuntimeSpecifier(input.bundleCode);
  await mkdir(evaluationDir, { recursive: true, mode: 0o700 });

  try {
    await Promise.all([
      writeFile(
        path.join(evaluationDir, RUNTIME_MODULE_FILE),
        runtimeSource,
        "utf8",
      ),
      writeFile(
        path.join(evaluationDir, DOCUMENT_MODULE_FILE),
        documentSource,
        "utf8",
      ),
    ]);

    const moduleUrl = pathToFileURL(
      path.join(evaluationDir, DOCUMENT_MODULE_FILE),
    );

    moduleUrl.searchParams.set("t", String(Date.now()));

    return await serializeEvaluation(async () => {
      // SAFETY: this private global is owned by the serialized import runtime.
      const globalHolder = globalThis as PublishValidationRuntimeGlobal;
      const previousRuntime = globalHolder[RUNTIME_GLOBAL];
      globalHolder[RUNTIME_GLOBAL] = runtime;

      try {
        await span(
          "evaluate: import document module",
          () => import(moduleUrl.href),
        );

        return null;
      } catch (error) {
        return errorMessage(error);
      } finally {
        globalHolder[RUNTIME_GLOBAL] = previousRuntime;
      }
    });
  } finally {
    await rm(evaluationDir, { recursive: true, force: true });
  }
}
