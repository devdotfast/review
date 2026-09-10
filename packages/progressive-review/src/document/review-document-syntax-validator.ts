import {
  type ImportDeclaration,
  type Node,
  ScriptKind,
  ScriptTarget,
  type SourceFile,
  createSourceFile,
  forEachChild,
  isDecorator,
  isEnumDeclaration,
  isImportDeclaration,
  isModuleDeclaration,
  isNamedImports,
  isParameter,
  isParameterPropertyDeclaration,
  isStringLiteral,
} from "typescript";

import { reviewAuthoringPropsSchemas } from "../authoring";
import { isAuthoringSpecifier } from "./authoring-environment";
import type { ReviewDocumentDiagnostic } from "./diagnostics";

export interface AuthoredTypescriptRegion {
  kind: "esm" | "expression";
  value: string;
  sourceStartLine: number;
  sourceStartColumn: number;
  virtualStartLine?: number;
  virtualEndLine?: number;
}

export function unsupportedTypescriptDiagnostics(
  input: { filePath: string },
  regions: readonly AuthoredTypescriptRegion[],
): ReviewDocumentDiagnostic[] {
  const diagnostics: ReviewDocumentDiagnostic[] = [];
  for (const region of regions) {
    const sourceFile = createSourceFile(
      input.filePath,
      region.value,
      ScriptTarget.Latest,
      true,
      ScriptKind.TS,
    );
    const visit = (node: Node): void => {
      if (isImportDeclaration(node)) {
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
      forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return diagnostics;
}

function importedMdxComponents(
  node: ImportDeclaration,
  sourceFile: SourceFile,
): Array<{ name: string; start: number }> {
  if (
    !isStringLiteral(node.moduleSpecifier) ||
    !isAuthoringSpecifier(node.moduleSpecifier.text)
  ) {
    return [];
  }
  const bindings = node.importClause?.namedBindings;
  if (!bindings || !isNamedImports(bindings)) return [];
  return bindings.elements.flatMap((element) => {
    const name = element.propertyName?.text ?? element.name.text;
    return Object.hasOwn(reviewAuthoringPropsSchemas, name)
      ? [{ name, start: element.getStart(sourceFile) }]
      : [];
  });
}

function unsupportedTypescriptNode(
  node: Node,
  sourceFile: SourceFile,
): { description: string; start: number } | null {
  if (isEnumDeclaration(node)) {
    return {
      description: "enum declarations",
      start: typescriptKeywordStart(node, sourceFile, /\benum\b/),
    };
  }
  if (isModuleDeclaration(node)) {
    return {
      description: "namespace declarations",
      start: typescriptKeywordStart(
        node,
        sourceFile,
        /\b(?:namespace|module)\b/,
      ),
    };
  }
  if (isDecorator(node)) {
    return { description: "decorators", start: node.getStart(sourceFile) };
  }
  if (
    isParameter(node) &&
    node.parent &&
    isParameterPropertyDeclaration(node, node.parent)
  ) {
    return {
      description: "parameter properties",
      start: node.getStart(sourceFile),
    };
  }
  return null;
}

function typescriptKeywordStart(
  node: Node,
  sourceFile: SourceFile,
  keyword: RegExp,
): number {
  const start = node.getStart(sourceFile);
  const match = keyword.exec(node.getText(sourceFile));
  return start + (match?.index ?? 0);
}
