import { createRequire } from "node:module";
import path from "node:path";

import ts from "typescript";

import { reviewAuthoringPropsSchemas } from "../authoring";
import { progressiveReviewAuthoringSourcePath } from "../package-paths";
import type { ReviewDocumentDiagnostic } from "./diagnostics";
import { unsupportedTypescriptDiagnostics } from "./review-document-syntax-validator";
import type {
  AuthoredSource,
  DocumentSyntax,
  DocumentSyntaxNode,
  SourceSpan,
} from "./syntax";

const require = createRequire(import.meta.url);
const helpers = [
  "defineActors",
  "defineAnchors",
  "defineSoftwareActors",
  "defineSoftwareStores",
  "defineStores",
] as const;

/** Only a diagnostic projection is emitted. This TSX is never executed,
 * bundled, persisted, or used to construct the published document. */
export function checkReviewDocument(input: {
  filePath: string;
  source: string;
  syntax: DocumentSyntax;
}): ReviewDocumentDiagnostic[] {
  const { syntax } = input;
  const point = (offset: number) => {
    const before = input.source.slice(0, offset);
    return {
      line: before.split("\n").length,
      column: offset - before.lastIndexOf("\n"),
    };
  };
  const unsupported = unsupportedTypescriptDiagnostics(
    input,
    [
      ...syntax.modules.map((region) => ({ ...region, kind: "esm" as const })),
      ...syntax.expressions.map((region) => ({
        ...region,
        kind: "expression" as const,
      })),
    ].map((region) => ({
      kind: region.kind,
      value: region.value,
      sourceStartLine: point(region.span.start).line,
      sourceStartColumn: point(region.span.start).column,
    })),
  );
  if (unsupported.length) return unsupported;

  const authoringPath = progressiveReviewAuthoringSourcePath(import.meta.url);
  const helpersPath = `${authoringPath}.document-helpers.ts`;
  const virtualPath = `${input.filePath}.tsx`;
  const helperSource = [
    `export * from ${JSON.stringify(authoringPath)};`,
    ...helpers.map(
      (name) =>
        `export declare const ${name}: import(${JSON.stringify(authoringPath)}).ReviewDefinitionSession[${JSON.stringify(name)}];`,
    ),
    `export declare const __reviewDefinitionsReady: () => Promise<void>;`,
  ].join("\n");
  let virtual =
    [
      `import type { ReviewAuthoringComponentRegistry as __ReviewComponents } from ${JSON.stringify(authoringPath)};`,
      `declare const __reviewComponents: __ReviewComponents;`,
      ...Object.keys(reviewAuthoringPropsSchemas)
        .filter((name) => !syntax.bindings.includes(name))
        .map(
          (name) =>
            `declare const ${name}: __ReviewComponents[${JSON.stringify(name)}];`,
        ),
      `import { ${[...helpers, "calls", "defineSoftwareModel", "__reviewDefinitionsReady"].filter((name) => !syntax.bindings.includes(name)).join(", ")} } from ${JSON.stringify(helpersPath)};`,
    ].join("\n") + "\n";
  const mappings: {
    start: number;
    end: number;
    source: SourceSpan;
    exact: boolean;
  }[] = [];
  const append = (value: string, span?: SourceSpan, exact = false) => {
    if (span)
      mappings.push({
        start: virtual.length,
        end: virtual.length + value.length,
        source: span,
        exact,
      });
    virtual += value;
  };
  const authored = (region: AuthoredSource) =>
    append(region.value, region.span, true);
  for (const region of syntax.modules) {
    authored(region);
    append("\n");
  }
  const expression = (index: number) => authored(syntax.expressions[index]);
  const node = (item: DocumentSyntaxNode): void => {
    if (item.kind === "text") {
      append(`{${JSON.stringify(item.value)}}`);
      return;
    }
    if (item.kind === "expression") {
      append("{");
      expression(item.expression);
      append("}");
      return;
    }
    const name =
      item.name && Object.hasOwn(reviewAuthoringPropsSchemas, item.name)
        ? `__reviewComponents.${item.name}`
        : (item.name ?? "");
    append(`<${name}`, item.span);
    for (const attribute of item.attributes) {
      append(" ");
      if (attribute.kind === "spread") {
        append("{");
        expression(attribute.expression);
        append("}");
      } else {
        append(attribute.name, attribute.span ?? item.span);
        append("={");
        if (attribute.kind === "literal")
          append(JSON.stringify(attribute.value), attribute.span ?? item.span);
        else expression(attribute.expression);
        append("}");
      }
    }
    if (!item.children.length && name) {
      append(" />", item.span);
      return;
    }
    append(">", item.span);
    item.children.forEach(node);
    append(`</${name}>`, item.span);
  };
  append("void (<>");
  syntax.body.forEach(node);
  append("</>);\n");
  const reactRoot = path.dirname(require.resolve("@types/react/package.json"));
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    noImplicitAny: false,
    noEmit: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
    paths: {
      react: [path.join(reactRoot, "index.d.ts")],
      "react/jsx-runtime": [path.join(reactRoot, "jsx-runtime.d.ts")],
      "react/jsx-dev-runtime": [path.join(reactRoot, "jsx-dev-runtime.d.ts")],
    },
  };
  const files = new Map([
    [virtualPath, virtual],
    [helpersPath, helperSource],
  ]);
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError, shouldCreate) =>
    files.has(file)
      ? ts.createSourceFile(
          file,
          files.get(file)!,
          languageVersion,
          true,
          ts.ScriptKind.TSX,
        )
      : originalGetSourceFile(file, languageVersion, onError, shouldCreate);
  const originalFileExists = host.fileExists.bind(host);
  host.fileExists = (file) => files.has(file) || originalFileExists(file);
  const originalReadFile = host.readFile.bind(host);
  host.readFile = (file) => files.get(file) ?? originalReadFile(file);
  const resolutionCache = ts.createModuleResolutionCache(
    path.dirname(input.filePath),
    host.getCanonicalFileName,
    options,
  );
  host.resolveModuleNameLiterals = (
    literals,
    containingFile,
    redirectedReference,
    compilerOptions,
    sourceFile,
  ) =>
    literals.map((literal) => {
      if (
        [
          "virtual:progressive-review-authoring",
          "@dev.fast/review/authoring",
        ].includes(literal.text)
      )
        return {
          resolvedModule: {
            resolvedFileName: helpersPath,
            extension: ts.Extension.Ts,
          },
        };
      return ts.resolveModuleName(
        literal.text.startsWith("/@fs/") ? literal.text.slice(5) : literal.text,
        containingFile,
        compilerOptions,
        host,
        resolutionCache,
        redirectedReference,
        ts.getModeForUsageLocation(sourceFile, literal, compilerOptions),
      );
    });
  const program = ts.createProgram([virtualPath], options, host);
  const diagnostics: ReviewDocumentDiagnostic[] = [];
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    if (diagnostic.file?.fileName !== virtualPath) continue;
    const start = diagnostic.start ?? 0;
    const mapping = mappings.find(
      (item) => start >= item.start && start < item.end,
    );
    // Unmapped diagnostics belong to our projection, not authored code. Do not
    // silently accept them: surface an infrastructure error for its owner.
    if (!mapping)
      throw new Error(
        `Document diagnostic projection: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
      );
    const offset =
      mapping.source.start + (mapping.exact ? start - mapping.start : 0);
    const position = point(offset);
    diagnostics.push({
      source: "typescript",
      severity:
        diagnostic.category === ts.DiagnosticCategory.Error
          ? "error"
          : "warning",
      code: `TS${diagnostic.code}`,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      filePath: input.filePath,
      ...position,
    });
  }
  return diagnostics;
}
