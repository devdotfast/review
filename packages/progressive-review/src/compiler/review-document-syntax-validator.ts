import ts from "typescript";

import { reviewAuthoringPropsSchemas } from "../authoring";
import type {
  ReviewDocumentDiagnostic,
  ReviewDocumentInput,
} from "./review-document-compiler";

export interface AuthoredTypescriptRegion {
  kind: "esm" | "expression";
  value: string;
  sourceStartLine: number;
  sourceStartColumn: number;
  virtualStartLine?: number;
  virtualEndLine?: number;
}

export function unsupportedTypescriptDiagnostics(
  input: Pick<ReviewDocumentInput, "filePath">,
  regions: readonly AuthoredTypescriptRegion[],
): ReviewDocumentDiagnostic[] {
  const diagnostics: ReviewDocumentDiagnostic[] = [];
  for (const region of regions) {
    const sourceFile = ts.createSourceFile(
      input.filePath,
      region.value,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        for (const imported of importedMdxComponents(node, sourceFile)) {
          const position = sourceFile.getLineAndCharacterOfPosition(
            imported.start,
          );
          diagnostics.push({
            source: "typescript",
            severity: "error",
            code: "MDX_COMPONENT_IMPORT",
            message: `\`${imported.name}\` is a built-in Review MDX component. Remove it from this import and use <${imported.name}> directly.`,
            filePath: input.filePath,
            line: region.sourceStartLine + position.line,
            column:
              position.character +
              1 +
              (position.line === 0 ? region.sourceStartColumn - 1 : 0),
          });
        }
      }
      const unsupported = unsupportedTypescriptNode(node, sourceFile);
      if (unsupported) {
        const position = sourceFile.getLineAndCharacterOfPosition(
          unsupported.start,
        );
        diagnostics.push({
          source: "typescript",
          severity: "error",
          code: "UNSUPPORTED_TYPESCRIPT_SYNTAX",
          message: `TypeScript ${unsupported.description} are not supported in Review MDX because they require runtime code generation.`,
          filePath: input.filePath,
          line: region.sourceStartLine + position.line,
          column:
            position.character +
            1 +
            (position.line === 0 ? region.sourceStartColumn - 1 : 0),
        });
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return diagnostics;
}

function importedMdxComponents(
  node: ts.ImportDeclaration,
  sourceFile: ts.SourceFile,
): Array<{ name: string; start: number }> {
  if (
    !ts.isStringLiteral(node.moduleSpecifier) ||
    node.moduleSpecifier.text !== "virtual:progressive-review-authoring"
  ) {
    return [];
  }
  const bindings = node.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return [];
  return bindings.elements.flatMap((element) => {
    const name = element.propertyName?.text ?? element.name.text;
    return Object.hasOwn(reviewAuthoringPropsSchemas, name)
      ? [{ name, start: element.getStart(sourceFile) }]
      : [];
  });
}

function unsupportedTypescriptNode(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): { description: string; start: number } | null {
  if (ts.isEnumDeclaration(node)) {
    return {
      description: "enum declarations",
      start: typescriptKeywordStart(node, sourceFile, /\benum\b/),
    };
  }
  if (ts.isModuleDeclaration(node)) {
    return {
      description: "namespace declarations",
      start: typescriptKeywordStart(
        node,
        sourceFile,
        /\b(?:namespace|module)\b/,
      ),
    };
  }
  if (ts.isDecorator(node)) {
    return { description: "decorators", start: node.getStart(sourceFile) };
  }
  if (
    ts.isParameter(node) &&
    node.parent &&
    ts.isParameterPropertyDeclaration(node, node.parent)
  ) {
    return {
      description: "parameter properties",
      start: node.getStart(sourceFile),
    };
  }
  return null;
}

function typescriptKeywordStart(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  keyword: RegExp,
): number {
  const start = node.getStart(sourceFile);
  const match = keyword.exec(node.getText(sourceFile));
  return start + (match?.index ?? 0);
}
