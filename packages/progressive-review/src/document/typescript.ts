import {
  type Diagnostic,
  DiagnosticCategory,
  JsxEmit,
  ModuleKind,
  ScriptTarget,
  createSourceFile,
  flattenDiagnosticMessageText,
  isExportDeclaration,
  isNamedExports,
  transpileModule,
} from "typescript";

import type { ReviewDocumentDiagnostic } from "./diagnostics";

/** Single-file emission retains TypeScript's import elision semantics. */
export function transformAuthoredModule(
  source: string,
  filename: string,
  typeOnlyExports: readonly string[] = [],
) {
  const annotations = annotateTypeOnlyExports(
    source,
    filename,
    typeOnlyExports,
  );
  const transformed = transpileModule(annotations?.source ?? source, {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: {
      module:
        filename.endsWith(".cts") || filename.endsWith(".cjs")
          ? ModuleKind.CommonJS
          : ModuleKind.ESNext,
      target: ScriptTarget.ES2022,
      jsx: JsxEmit.ReactJSX,
      verbatimModuleSyntax: false,
    },
  });
  if (!annotations) return transformed;
  // Inserting type modifiers must not shift an authored helper's diagnostics.
  return {
    ...transformed,
    diagnostics: transformed.diagnostics?.map((diagnostic) => {
      if (!diagnostic.file || diagnostic.start === undefined) return diagnostic;
      const start = annotations.originalOffset(diagnostic.start);
      return {
        ...diagnostic,
        file: annotations.original,
        start,
        length:
          diagnostic.length === undefined
            ? undefined
            : annotations.originalOffset(diagnostic.start + diagnostic.length) -
              start,
      };
    }),
  };
}

function annotateTypeOnlyExports(
  source: string,
  filename: string,
  typeOnlyExports: readonly string[],
) {
  if (!typeOnlyExports.length) return null;
  const names = new Set(typeOnlyExports);
  const original = createSourceFile(
    filename,
    source,
    ScriptTarget.Latest,
    true,
  );
  const insertions: number[] = [];
  for (const statement of original.statements) {
    if (
      !isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      !statement.exportClause ||
      !isNamedExports(statement.exportClause)
    )
      continue;
    for (const specifier of statement.exportClause.elements)
      if (!specifier.isTypeOnly && names.has(specifier.name.text))
        insertions.push(specifier.getStart(original));
  }
  if (!insertions.length) return null;
  // Annotate before parsing for emission: replacing export AST nodes in a
  // `before` transformer disables TypeScript's normal alias elision, including
  // the imports used only by a local `export { Interface }` declaration.
  for (const offset of insertions.toReversed())
    source = `${source.slice(0, offset)}type ${source.slice(offset)}`;
  return {
    source,
    original,
    originalOffset(offset: number): number {
      let added = 0;
      for (const insertion of insertions) {
        const position = insertion + added;
        if (offset < position) break;
        if (offset < position + 5) return insertion;
        added += 5;
      }
      return offset - added;
    },
  };
}

/** Callers choose which diagnostics to report and map their own source spans. */
export function typescriptDiagnostic(
  diagnostic: Diagnostic,
  location: Pick<ReviewDocumentDiagnostic, "filePath" | "line" | "column">,
): ReviewDocumentDiagnostic {
  return {
    source: "typescript",
    severity:
      diagnostic.category === DiagnosticCategory.Error ? "error" : "warning",
    code: `TS${diagnostic.code}`,
    message: flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    ...location,
  };
}
