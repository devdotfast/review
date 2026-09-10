import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { type Diagnostic, DiagnosticCategory } from "typescript";

import { reviewAuthoringPropsSchemas } from "../authoring";
import { errorMessage } from "../error-message";
import type { PublishValidationRuntime } from "../review-publication-audit";
import type { PublishValidationProps } from "../review-publish-element-audit";
import {
  isAuthoringSpecifier,
  reviewHelperImports,
} from "./authoring-environment";
import { constructDocument } from "./construct";
import {
  type ReviewDocumentDiagnostic,
  formatReviewDocumentDiagnostics,
} from "./diagnostics";
import type { DocumentSyntax } from "./syntax";
import { transformAuthoredModule, typescriptDiagnostic } from "./typescript";

/** Load authored modules inside the caller's disposable worker. This owns
 * module hooks and source mapping; it does not communicate with the parent. */
export async function loadDocumentModule(
  input: {
    reviewPath: string;
    routePath: string;
    syntax: DocumentSyntax;
    runtimeBindings: string[];
    typeOnlyExports: Record<string, string[]>;
  },
  runtime: PublishValidationRuntime,
  helperDiagnostics: ReviewDocumentDiagnostic[],
): Promise<string | null> {
  const reviewPath = realpathSync(input.reviewPath);
  const tree = input.syntax;
  const moduleSource = [
    reviewHelperImports(new Set(tree.bindings)),
    ...tree.modules.map((module) => module.value),
    `export const __reviewExpressions = [${tree.expressions
      .map(
        (expression) =>
          `(__reviewComponents) => { const {${Object.keys(
            reviewAuthoringPropsSchemas,
          )
            .filter((name) => !tree.bindings.includes(name))
            .join(
              ",",
            )}} = __reviewComponents; return (${expression.value.startsWith("...") ? `{${expression.value}}` : expression.value}); }`,
      )
      .join(",\n")}];`,
    `export const __reviewModels = {${input.runtimeBindings.join(",")}};`,
  ].join("\n");
  const documentModuleFilename = `${reviewPath}.tsx`;
  const id = randomUUID();
  const documentUrl = pathToFileURL(reviewPath);
  documentUrl.searchParams.set("pipeline", id);
  const authoringUrl = `review-document:${id}/authoring`;
  const runtimeUrl = `review-document:${id}/runtime`;

  const loadedHelpers = new Set<string>();

  const session = runtime.createBrowserReviewDefinitionSession({});
  session.begin();
  const slot = `__reviewDocument_${id.replaceAll("-", "")}`;
  const runtimeValues = {
    ...runtime,
    ...session,
    __reviewDefinitionsReady: session.ready,
  };
  Object.defineProperty(globalThis, slot, {
    value: runtimeValues,
    configurable: true,
  });
  const runtimeSource =
    Object.keys(runtimeValues)
      .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name))
      .map(
        (name) =>
          `export const ${name} = globalThis[${JSON.stringify(slot)}][${JSON.stringify(name)}];`,
      )
      .join("\n") +
    `\nexport default globalThis[${JSON.stringify(slot)}].React;`;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (isAuthoringSpecifier(specifier))
        return { url: authoringUrl, shortCircuit: true };
      if (
        ["react", "react/jsx-runtime", "react/jsx-dev-runtime"].includes(
          specifier,
        )
      )
        return { url: runtimeUrl, shortCircuit: true };
      if (specifier === documentUrl.href)
        return { url: documentUrl.href, shortCircuit: true };
      if (
        (specifier.startsWith(".") ||
          specifier.startsWith("file:") ||
          path.isAbsolute(specifier)) &&
        context.parentURL?.startsWith("file:")
      ) {
        const resolved = resolveLocalFile(
          new URL(specifier, context.parentURL),
        );
        if (resolved) return { url: resolved, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === authoringUrl || url === runtimeUrl)
        return {
          format: "module",
          source: runtimeSource,
          shortCircuit: true,
        };
      if (url === documentUrl.href)
        return {
          format: "module",
          source: emit(moduleSource, documentModuleFilename),
          shortCircuit: true,
        };
      if (url.startsWith("file:")) {
        const filename = fileURLToPath(url);
        if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(filename))
          loadedHelpers.add(filename);
        if (/\.(?:ts|tsx|mts|cts|jsx)$/.test(filename)) {
          return {
            format: filename.endsWith(".cts") ? "commonjs" : "module",
            source: emit(readFileSync(filename, "utf8"), filename),
            shortCircuit: true,
          };
        }
        // Existing authoring accepts JSON imports without import attributes.
        if (filename.endsWith(".json"))
          return {
            format: "module",
            source: `export default ${JSON.stringify(JSON.parse(readFileSync(filename, "utf8")))};`,
            shortCircuit: true,
          };
      }
      return nextLoad(url, context);
    },
  });
  try {
    const data = await import(documentUrl.href);
    await session.ready();
    runtime.createActiveReviewDocument({
      title: tree.title,
      routePath: input.routePath,
      filePath: reviewPath,
      modelNames: tree.declaredModelNames ?? [],
      models: { ...data, ...data.__reviewModels },
      Component: (props: PublishValidationProps) =>
        constructDocument(
          tree,
          runtime,
          props,
          data.__reviewExpressions,
          data.__reviewModels,
        ),
    });
    return null;
  } catch (error) {
    // Linking may fail before a malformed CJS helper is evaluated. Recover its
    // original syntax location using the same transform as normal loading.
    for (const filename of loadedHelpers) {
      try {
        const transformed = transformAuthoredModule(
          readFileSync(filename, "utf8"),
          filename,
          input.typeOnlyExports[filename],
        );
        helperDiagnostics.push(
          ...helperSyntaxDiagnostics(filename, transformed.diagnostics ?? []),
        );
      } catch {
        /* Preserve the original import error if its source vanished. */
      }
    }
    return errorMessage(error);
  } finally {
    hooks.deregister();
    Reflect.deleteProperty(globalThis, slot);
  }

  function emit(source: string, filename: string): string {
    const transformed = transformAuthoredModule(
      source,
      filename,
      input.typeOnlyExports[
        filename === documentModuleFilename ? reviewPath : filename
      ],
    );
    const diagnostics = helperSyntaxDiagnostics(
      filename,
      transformed.diagnostics ?? [],
    );
    if (diagnostics.length)
      throw new Error(formatReviewDocumentDiagnostics(diagnostics));
    return transformed.outputText;
  }

  function helperSyntaxDiagnostics(
    filename: string,
    diagnostics: readonly Diagnostic[],
  ): ReviewDocumentDiagnostic[] {
    return diagnostics
      .filter((diagnostic) => diagnostic.category === DiagnosticCategory.Error)
      .map((diagnostic) => {
        const point =
          diagnostic.file && diagnostic.start !== undefined
            ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
            : undefined;
        return typescriptDiagnostic(diagnostic, {
          filePath: authoredSourcePath(diagnostic.file?.fileName ?? filename),
          line: point ? point.line + 1 : undefined,
          column: point ? point.character + 1 : undefined,
        });
      });
  }

  function authoredSourcePath(filename: string): string {
    const root = path.dirname(reviewPath);
    const resolved = path.resolve(filename);
    return resolved.startsWith(root + path.sep)
      ? path.join(path.dirname(input.reviewPath), path.relative(root, resolved))
      : filename;
  }

  function resolveLocalFile(url: URL): string | null {
    const filename = fileURLToPath(url);
    const extension = path.extname(filename);
    const replacements =
      extension === ".js" || extension === ".jsx"
        ? [".ts", ".tsx"]
        : extension === ".mjs"
          ? [".mts"]
          : extension === ".cjs"
            ? [".cts"]
            : [];
    for (const candidate of [
      filename,
      ...[
        ".ts",
        ".tsx",
        ".mts",
        ".cts",
        ".js",
        ".jsx",
        ".mjs",
        ".cjs",
        ".json",
      ].map((extension) => filename + extension),
      ...replacements.map(
        (replacement) => filename.slice(0, -extension.length) + replacement,
      ),
      path.join(filename, "index.ts"),
      path.join(filename, "index.js"),
    ]) {
      try {
        if (statSync(candidate).isFile())
          return pathToFileURL(realpathSync(candidate)).href;
      } catch {
        /* Let Node report missing imports with its original context. */
      }
    }
    return null;
  }
}
