import { existsSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import {
  type CompilerOptions,
  Extension,
  JsxEmit,
  ModuleKind,
  ModuleResolutionKind,
  ScriptKind,
  ScriptTarget,
  type Symbol,
  SymbolFlags,
  type TypeChecker,
  createCompilerHost,
  createModuleResolutionCache,
  createProgram,
  createSourceFile,
  flattenDiagnosticMessageText,
  getModeForUsageLocation,
  getPreEmitDiagnostics,
  isExportDeclaration,
  isNamedExports,
  isTypeOnlyImportOrExportDeclaration,
  resolveModuleName,
} from "typescript";

import { reviewAuthoringPropsSchemas } from "../authoring";
import { progressiveReviewAuthoringTypesPath } from "../package-paths";
import {
  isAuthoringSpecifier,
  reviewHelperImports,
  sessionHelperNames,
} from "./authoring-environment";
import type { ReviewDocumentDiagnostic } from "./diagnostics";
import { unsupportedTypescriptDiagnostics } from "./review-document-syntax-validator";
import type {
  AuthoredSource,
  DocumentSyntax,
  DocumentSyntaxNode,
  SourceSpan,
} from "./syntax";
import { typescriptDiagnostic } from "./typescript";

const require = createRequire(import.meta.url);

export interface DocumentCheckResult {
  diagnostics: ReviewDocumentDiagnostic[];
  runtimeBindings: string[];
  typeOnlyExports: Record<string, string[]>;
}

/** Only a diagnostic projection is emitted. This TSX is never executed,
 * bundled, persisted, or used to construct the published document. */
export function checkReviewDocument(input: {
  filePath: string;
  source: string;
  syntax: DocumentSyntax;
  typecheck?: "document" | "review";
}): DocumentCheckResult {
  const { syntax } = input;
  const filePath = path.resolve(input.filePath);
  const point = (offset: number) => {
    const before = input.source.slice(0, offset);
    return {
      line: before.split("\n").length,
      column: offset - before.lastIndexOf("\n"),
    };
  };
  const unsupported = unsupportedTypescriptDiagnostics(
    { filePath },
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
  if (unsupported.length)
    return {
      diagnostics: unsupported,
      runtimeBindings: [],
      typeOnlyExports: {},
    };

  const authoringPath = progressiveReviewAuthoringTypesPath(import.meta.url);
  if (!existsSync(authoringPath))
    throw new Error(`Review authoring types are missing: ${authoringPath}`);
  const authoringModulePath = authoringPath.replace(/\.d\.ts$/, ".js");
  const helpersPath = path.join(
    path.dirname(authoringPath),
    "review-document-helpers.ts",
  );
  const virtualPath = `${filePath}.tsx`;
  const helperSource = [
    `export * from ${JSON.stringify(authoringModulePath)};`,
    ...sessionHelperNames.map(
      (name) =>
        `export declare const ${name}: import(${JSON.stringify(authoringModulePath)}).ReviewDefinitionSession[${JSON.stringify(name)}];`,
    ),
    `export declare const __reviewDefinitionsReady: () => Promise<void>;`,
  ].join("\n");
  let virtual =
    [
      `import type { ReviewAuthoringComponentRegistry as __ReviewComponents } from ${JSON.stringify(authoringModulePath)};`,
      `declare const __reviewComponents: __ReviewComponents;`,
      ...Object.keys(reviewAuthoringPropsSchemas)
        .filter((name) => !syntax.bindings.includes(name))
        .map(
          (name) =>
            `declare const ${name}: __ReviewComponents[${JSON.stringify(name)}];`,
        ),
      reviewHelperImports(new Set(syntax.bindings), helpersPath),
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
  const options: CompilerOptions = {
    target: ScriptTarget.ES2022,
    module: ModuleKind.ESNext,
    moduleResolution: ModuleResolutionKind.Bundler,
    jsx: JsxEmit.ReactJSX,
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
  const host = createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError, shouldCreate) =>
    files.has(file)
      ? createSourceFile(
          file,
          files.get(file)!,
          languageVersion,
          true,
          ScriptKind.TSX,
        )
      : originalGetSourceFile(file, languageVersion, onError, shouldCreate);
  const originalFileExists = host.fileExists.bind(host);
  host.fileExists = (file) => files.has(file) || originalFileExists(file);
  const originalReadFile = host.readFile.bind(host);
  host.readFile = (file) => files.get(file) ?? originalReadFile(file);
  const resolutionCache = createModuleResolutionCache(
    path.dirname(filePath),
    host.getCanonicalFileName,
    options,
  );
  // Internal-test checks even helpers the document does not import. Publishing
  // deliberately keeps its MDX-only semantic-checking boundary.
  const helperFiles = new Set(
    input.typecheck === "review"
      ? readdirSync(path.dirname(filePath), { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
          .map((entry) => path.join(path.dirname(filePath), entry.name))
      : [],
  );
  const rootFiles = [virtualPath, ...helperFiles];
  host.resolveModuleNameLiterals = (
    literals,
    containingFile,
    redirectedReference,
    compilerOptions,
    sourceFile,
  ) =>
    literals.map((literal) => {
      if (isAuthoringSpecifier(literal.text))
        return {
          resolvedModule: {
            resolvedFileName: helpersPath,
            extension: Extension.Ts,
          },
        };
      const resolution = resolveModuleName(
        literal.text.startsWith("/@fs/") ? literal.text.slice(5) : literal.text,
        containingFile,
        compilerOptions,
        host,
        resolutionCache,
        redirectedReference,
        getModeForUsageLocation(sourceFile, literal, compilerOptions),
      );
      const resolved = resolution.resolvedModule;
      if (
        (containingFile === virtualPath || helperFiles.has(containingFile)) &&
        resolved &&
        !resolved.isExternalLibraryImport &&
        !files.has(resolved.resolvedFileName) &&
        resolved.resolvedFileName !== authoringPath
      )
        helperFiles.add(resolved.resolvedFileName);
      return resolution;
    });
  const program = createProgram(rootFiles, options, host);
  const virtualFile = program.getSourceFile(virtualPath)!;
  const diagnostics: ReviewDocumentDiagnostic[] = [];
  for (const diagnostic of getPreEmitDiagnostics(program, virtualFile)) {
    if (diagnostic.file && diagnostic.file.fileName !== virtualPath) continue;
    const start = diagnostic.start ?? 0;
    const mapping = mappings.find(
      (item) => start >= item.start && start < item.end,
    );
    // Unmapped diagnostics belong to our projection, not authored code. Do not
    // silently accept them: surface an infrastructure error for its owner.
    if (!mapping)
      throw new Error(
        `Document diagnostic projection: ${flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
      );
    const offset =
      mapping.source.start + (mapping.exact ? start - mapping.start : 0);
    const position = point(offset);
    diagnostics.push(
      typescriptDiagnostic(diagnostic, {
        filePath: filePath,
        ...position,
      }),
    );
  }
  if (input.typecheck === "review") {
    for (const helper of helperFiles) {
      const file = program.getSourceFile(helper);
      if (!file || file.isDeclarationFile) continue;
      for (const diagnostic of [
        ...program.getSyntacticDiagnostics(file),
        ...program.getSemanticDiagnostics(file),
      ]) {
        const point = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
        diagnostics.push(
          typescriptDiagnostic(diagnostic, {
            filePath: helper,
            line: point.line + 1,
            column: point.character + 1,
          }),
        );
      }
    }
  }
  const checker = program.getTypeChecker();
  const typeOnlyExports: Record<string, string[]> = {};
  // Single-file emission cannot infer that a re-exported name denotes only a
  // type. Reuse this graph for that fact, without expanding publish diagnostics
  // to helper semantics or sending compiler objects across the worker boundary.
  for (const filename of [virtualPath, ...helperFiles]) {
    const file = program.getSourceFile(filename);
    if (!file || file.isDeclarationFile) continue;
    const names: string[] = [];
    for (const statement of file.statements) {
      if (
        !isExportDeclaration(statement) ||
        statement.isTypeOnly ||
        !statement.exportClause ||
        !isNamedExports(statement.exportClause)
      )
        continue;
      for (const specifier of statement.exportClause.elements) {
        if (specifier.isTypeOnly) continue;
        const symbol = checker.getSymbolAtLocation(specifier.name);
        if (symbol && !hasRuntimeValue(symbol, checker))
          names.push(specifier.name.text);
      }
    }
    if (names.length) {
      // Standalone checker callers may provide a virtual MDX source, while
      // files loaded by the worker need the same canonical symlink identity.
      const authoredPath =
        filename === virtualPath && !existsSync(filePath)
          ? filePath
          : realpathSync(filename === virtualPath ? filePath : filename);
      typeOnlyExports[authoredPath] = names;
    }
  }
  const values = new Set(
    checker
      .getSymbolsInScope(virtualFile, SymbolFlags.Value | SymbolFlags.Alias)
      .filter((symbol) => hasRuntimeValue(symbol, checker))
      .map((symbol) => symbol.name),
  );
  return {
    diagnostics,
    runtimeBindings: syntax.bindings.filter((name) => values.has(name)),
    typeOnlyExports,
  };
}

function hasRuntimeValue(symbol: Symbol, checker: TypeChecker): boolean {
  const seen = new Set<Symbol>();
  while (symbol.flags & SymbolFlags.Alias) {
    if (seen.has(symbol)) return false;
    seen.add(symbol);
    if (symbol.declarations?.some(isTypeOnlyImportOrExportDeclaration))
      return false;
    symbol =
      checker.getImmediateAliasedSymbol(symbol) ??
      checker.getAliasedSymbol(symbol);
  }
  return Boolean(symbol.flags & SymbolFlags.Value);
}
