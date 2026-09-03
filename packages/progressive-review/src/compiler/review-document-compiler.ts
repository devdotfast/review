import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { compile } from "@mdx-js/mdx";
import type { Nodes as MdastNode, Root } from "mdast";
import remarkMdx from "remark-mdx";
import {
  type RawSourceMap,
  SourceMapConsumer,
  SourceMapGenerator,
} from "source-map";
import ts from "typescript";
import { z } from "zod";

import {
  progressiveReviewAppSourcePath,
  progressiveReviewAuthoringSourcePath,
} from "../package-paths";
import { maskReviewFrontmatter } from "../review-frontmatter";
import {
  type ReviewMdxDocument,
  isMdxAttributeValueExpression,
  parseReviewMdxDocument,
} from "../review-mdx-ast";
import { reviewTypescriptEstreeParser } from "../review-mdx-typescript-parser";
import { normalizeViteModuleFilePath } from "../review-paths";
import { unsupportedTypescriptDiagnostics } from "./review-document-syntax-validator";
import type { AuthoredTypescriptRegion } from "./review-document-syntax-validator";
import { reviewMdxOptions } from "./review-mdx-options";
import { reviewHelperImports } from "./review-mdx-transform";

const require = createRequire(import.meta.url);

export interface ReviewDocumentInput {
  filePath: string;
  source: string;
  reviewRootPath: string;
}

export interface ReviewDocumentDiagnostic {
  source: "mdx" | "typescript" | "review" | "evidence";
  severity: "error" | "warning";
  code: string;
  message: string;
  filePath: string;
  line?: number;
  column?: number;
}

export interface ReviewDocumentCompilation {
  runtimeCode?: string;
  runtimeMap?: RawSourceMap;
  diagnostics: ReviewDocumentDiagnostic[];
  reviewDocument: ReviewMdxDocument;
}

export function formatReviewDocumentDiagnostics(
  diagnostics: readonly ReviewDocumentDiagnostic[],
): string {
  return diagnostics
    .map((diagnostic) => {
      const location = [diagnostic.filePath, diagnostic.line, diagnostic.column]
        .filter((value) => value !== undefined)
        .join(":");
      const summary = `${location} ${diagnostic.code}: ${diagnostic.message}`;
      const codeFrame = formatDiagnosticCodeFrame(diagnostic);
      return codeFrame ? `${summary}\n${codeFrame}` : summary;
    })
    .join("\n");
}

function formatDiagnosticCodeFrame(
  diagnostic: ReviewDocumentDiagnostic,
): string | null {
  if (
    !Number.isInteger(diagnostic.line) ||
    !Number.isInteger(diagnostic.column) ||
    diagnostic.line === undefined ||
    diagnostic.column === undefined ||
    diagnostic.line < 1 ||
    diagnostic.column < 1
  ) {
    return null;
  }
  try {
    const sourceLine = readFileSync(diagnostic.filePath, "utf8").split(
      /\r\n|\n|\r/,
    )[diagnostic.line - 1];
    if (sourceLine === undefined || diagnostic.column > sourceLine.length + 1) {
      return null;
    }
    const safeLine = sanitizeDiagnosticSource(sourceLine);
    let caretOffset = sanitizeDiagnosticSource(
      sourceLine.slice(0, diagnostic.column - 1),
    ).length;
    const maxLength = 160;
    let windowStart = Math.max(0, caretOffset - 80);
    let windowEnd = Math.min(safeLine.length, windowStart + maxLength);
    if (windowEnd === safeLine.length) {
      windowStart = Math.max(0, windowEnd - maxLength);
    }
    const leadingEllipsis = windowStart > 0 ? "…" : "";
    const trailingEllipsis = windowEnd < safeLine.length ? "…" : "";
    const visibleLine = `${leadingEllipsis}${safeLine.slice(windowStart, windowEnd)}${trailingEllipsis}`;
    caretOffset =
      leadingEllipsis.length + Math.max(0, caretOffset - windowStart);
    const gutterWidth = String(diagnostic.line).length;
    return [
      `${diagnostic.line} | ${visibleLine}`,
      `${" ".repeat(gutterWidth)} | ${" ".repeat(caretOffset)}^`,
    ].join("\n");
  } catch {
    return null;
  }
}

function sanitizeDiagnosticSource(source: string): string {
  return source
    .replaceAll("\t", "  ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�");
}

// ESTree property values: child nodes, lists of children, or literal scalars.
type EstreeValue =
  | EstreeNode
  | EstreeValue[]
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined;

interface EstreeNode {
  type?: string;
  [property: string]: EstreeValue;
}

interface GeneratedMdxRegion {
  virtualStartLine: number;
  virtualEndLine: number;
  runtimeStartLine: number;
}

const reviewModuleExtensions = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
] as const;

/**
 * Returns every local path whose contents can affect semantic checking of a
 * Review document. Missing resolution candidates are included deliberately so
 * diagnostics include modules created after a previous compilation.
 */
export function collectReviewDocumentDependencies(
  input: ReviewDocumentInput,
): string[] {
  const dependencies = new Set<string>();
  const visited = new Set<string>();
  const pending: Array<{ filePath: string; source?: string }> = [
    { filePath: input.filePath, source: input.source },
    { filePath: resolveAuthoringSourcePath() },
  ];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    const resolvedPath = normalizeViteModuleFilePath(current.filePath);
    if (visited.has(resolvedPath)) continue;
    visited.add(resolvedPath);

    let source = current.source;
    if (source === undefined) {
      dependencies.add(resolvedPath);
      if (!existsSync(resolvedPath)) continue;
      try {
        source = readFileSync(resolvedPath, "utf8");
      } catch {
        continue;
      }
    }

    const importedFiles = ts.preProcessFile(source, true, true).importedFiles;
    for (const importedFile of importedFiles) {
      const candidates = reviewModuleResolutionCandidates(
        importedFile.fileName,
        resolvedPath,
      );
      for (const candidate of candidates) dependencies.add(candidate);
      const dependency = candidates.find((candidate) => existsSync(candidate));
      if (dependency && !visited.has(dependency)) {
        pending.push({ filePath: dependency });
      }
    }
  }

  dependencies.delete(normalizeViteModuleFilePath(input.filePath));
  return [...dependencies].sort();
}

function reviewDocumentDependencyFingerprint(input: ReviewDocumentInput) {
  const hash = crypto.createHash("sha256");
  for (const dependency of collectReviewDocumentDependencies(input)) {
    hash.update(dependency).update("\0");
    try {
      hash.update(readFileSync(dependency)).update("\0");
    } catch {
      hash.update("<missing>\0");
    }
  }
  return hash.digest("hex");
}

export function reviewDocumentRevision(input: ReviewDocumentInput): string {
  return crypto
    .createHash("sha256")
    .update(ts.version)
    .update("\0")
    .update(reviewDocumentDependencyFingerprint(input))
    .update("\0")
    .update(normalizeViteModuleFilePath(input.filePath))
    .update("\0")
    .update(normalizeViteModuleFilePath(input.reviewRootPath))
    .update("\0")
    .update(input.source)
    .digest("hex");
}

export async function compileReviewDocument(
  input: ReviewDocumentInput,
): Promise<ReviewDocumentCompilation> {
  const authoredTypescript: AuthoredTypescriptRegion[] = [];
  const source = maskReviewFrontmatter(input.source);
  const reviewDocument = parseReviewMdxDocument(source);
  let file: Awaited<ReturnType<typeof compile>>;
  try {
    file = await compile(
      { path: input.filePath, value: source },
      {
        ...reviewMdxOptions,
        SourceMapGenerator,
        format: "md",
        jsx: true,
        remarkPlugins: [
          [remarkMdx, { acorn: reviewTypescriptEstreeParser }],
          collectAuthoredTypescript(authoredTypescript),
          ...(reviewMdxOptions.remarkPlugins ?? []),
        ],
        recmaPlugins: [eraseTypescriptRecma],
      },
    );
  } catch (error) {
    const unsupportedDiagnostics = unsupportedTypescriptDiagnostics(
      input,
      authoredTypescript,
    );
    if (unsupportedDiagnostics.length > 0) {
      return { diagnostics: unsupportedDiagnostics, reviewDocument };
    }
    return {
      diagnostics: [mdxDiagnostic(input.filePath, error)],
      reviewDocument,
    };
  }
  const mdxCode = String(file);
  const runtimeMap = file.map as RawSourceMap | undefined;
  const syntaxDiagnostics = unsupportedTypescriptDiagnostics(
    input,
    authoredTypescript,
  );
  if (
    syntaxDiagnostics.some(
      (diagnostic) => diagnostic.code === "MDX_COMPONENT_IMPORT",
    )
  ) {
    return { diagnostics: syntaxDiagnostics, reviewDocument };
  }
  const typescriptDiagnostics = await checkAuthoredTypescript(
    input,
    authoredTypescript,
    mdxCode,
    runtimeMap,
  );
  const diagnostics = [...syntaxDiagnostics, ...typescriptDiagnostics];
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { diagnostics, reviewDocument };
  }
  const runtime = await emitReviewRuntime(input.filePath, mdxCode, runtimeMap);
  return {
    runtimeCode: runtime.code,
    runtimeMap: runtime.map,
    diagnostics,
    reviewDocument,
  };
}

async function emitReviewRuntime(
  filePath: string,
  mdxCode: string,
  mdxMap: RawSourceMap | undefined,
): Promise<{ code: string; map?: RawSourceMap }> {
  const transpileInput = mdxCode.replace(
    /^\/\*@jsxRuntime[^\n]*\n\/\*@jsxImportSource[^\n]*\n/,
    (pragma) => pragma.replace(/[^\n]/g, " "),
  );
  const emitted = ts.transpileModule(transpileInput, {
    fileName: `${filePath}.tsx`,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      sourceMap: true,
      inlineSources: true,
    },
  });
  const emittedCode = emitted.outputText.replace(
    /\n?\/\/# sourceMappingURL=.*$/,
    "",
  );
  const prefix = `${reviewHelperImports(importedLocalBindings(emittedCode))}\n\n`;
  const code = `${prefix}${emittedCode}\n\nawait __reviewDefinitionsReady();\n`;
  if (!emitted.sourceMapText || !mdxMap) return { code };
  return {
    code,
    map: await composeRuntimeSourceMap({
      filePath,
      prefixLineOffset: countLines(prefix) - 1,
      transpileMap: JSON.parse(emitted.sourceMapText) as RawSourceMap,
      mdxMap,
    }),
  };
}

function importedLocalBindings(source: string): Set<string> {
  const bindings = new Set<string>();
  const sourceFile = ts.createSourceFile(
    "review-document-runtime.js",
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) bindings.add(clause.name.text);
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      bindings.add(clause.namedBindings.name.text);
      continue;
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        bindings.add(element.name.text);
      }
    }
  }
  return bindings;
}

async function composeRuntimeSourceMap(input: {
  filePath: string;
  prefixLineOffset: number;
  transpileMap: RawSourceMap;
  mdxMap: RawSourceMap;
}): Promise<RawSourceMap> {
  const transpileConsumer = await new SourceMapConsumer(input.transpileMap);
  const mdxConsumer = await new SourceMapConsumer(input.mdxMap);
  const generator = new SourceMapGenerator({ file: input.filePath });
  try {
    transpileConsumer.eachMapping((mapping) => {
      if (mapping.originalLine === null || mapping.originalColumn === null) {
        return;
      }
      const authored = mdxConsumer.originalPositionFor({
        line: mapping.originalLine,
        column: mapping.originalColumn,
      });
      if (
        authored.line === null ||
        authored.column === null ||
        authored.source === null
      ) {
        return;
      }
      generator.addMapping({
        generated: {
          line: mapping.generatedLine + input.prefixLineOffset,
          column: mapping.generatedColumn,
        },
        original: { line: authored.line, column: authored.column },
        source: input.filePath,
        ...(authored.name ? { name: authored.name } : {}),
      });
    });
    if (input.mdxMap.sourcesContent?.[0] !== undefined) {
      generator.setSourceContent(
        input.filePath,
        input.mdxMap.sourcesContent[0],
      );
    }
    return generator.toJSON();
  } finally {
    transpileConsumer.destroy();
    mdxConsumer.destroy();
  }
}

// The mdast nodes that carry authored JavaScript: ESM blocks, expressions in
// flow or text position, and JSX attribute value expressions.
type AuthoredMdxNode = { value: string } & Pick<MdastNode, "position">;

function collectAuthoredTypescript(regions: AuthoredTypescriptRegion[]) {
  const collect = (
    kind: AuthoredTypescriptRegion["kind"],
    node: AuthoredMdxNode,
  ): void => {
    if (!node.value.trim()) return;
    regions.push({
      kind,
      value: node.value,
      sourceStartLine: node.position?.start.line ?? 1,
      sourceStartColumn:
        (node.position?.start.column ?? 1) + (kind === "expression" ? 1 : 0),
    });
  };
  return () => (tree: Root) => {
    walkMdast(tree, (node) => {
      if (node.type === "mdxjsEsm") {
        collect("esm", node);
      } else if (
        node.type === "mdxFlowExpression" ||
        node.type === "mdxTextExpression"
      ) {
        collect("expression", node);
      } else if (
        node.type === "mdxJsxFlowElement" ||
        node.type === "mdxJsxTextElement"
      ) {
        for (const attribute of node.attributes) {
          if (
            attribute.type === "mdxJsxAttribute" &&
            isMdxAttributeValueExpression(attribute.value)
          ) {
            collect("expression", attribute.value);
          }
        }
      }
    });
  };
}

function checkAuthoredTypescript(
  input: ReviewDocumentInput,
  regions: AuthoredTypescriptRegion[],
  runtimeCode: string,
  runtimeMap: RawSourceMap | undefined,
): Promise<ReviewDocumentDiagnostic[]> {
  const authoringPath = resolveAuthoringSourcePath();
  const virtualFilePath = `${input.filePath}.tsx`;
  const sourceParts = [
    `import type { ReviewAuthoringComponentRegistry as __ReviewComponents } from ${JSON.stringify(authoringPath)};`,
    `type __ReviewDefinitions = import(${JSON.stringify(authoringPath)}).ReviewDefinitionSession;`,
    `declare const calls: typeof import(${JSON.stringify(authoringPath)}).calls;`,
    `declare const defineActors: __ReviewDefinitions["defineActors"];`,
    `declare const defineAnchors: __ReviewDefinitions["defineAnchors"];`,
    `declare const defineSoftwareActors: __ReviewDefinitions["defineSoftwareActors"];`,
    `declare const defineSoftwareModel: typeof import(${JSON.stringify(authoringPath)}).defineSoftwareModel;`,
    `declare const defineSoftwareStores: __ReviewDefinitions["defineSoftwareStores"];`,
    `declare const defineStores: __ReviewDefinitions["defineStores"];`,
    `declare function _missingMdxReference(id: string, component: boolean): never;`,
  ];
  let nextVirtualLine = sourceParts.length + 1;
  for (const region of regions) {
    const rewritten =
      region.kind === "esm"
        ? rewriteAuthoringModuleSpecifier(region.value, authoringPath)
        : region.value;
    if (region.kind === "expression") {
      sourceParts.push("void (");
      nextVirtualLine += 1;
    }
    region.virtualStartLine = nextVirtualLine;
    const lineCount = countLines(rewritten);
    region.virtualEndLine = nextVirtualLine + lineCount - 1;
    sourceParts.push(rewritten);
    nextVirtualLine += lineCount;
    if (region.kind === "expression") {
      sourceParts.push(");");
      nextVirtualLine += 1;
    }
  }
  const generatedMdx = extractGeneratedMdxContent(runtimeCode);
  let generatedRegion: GeneratedMdxRegion | undefined;
  if (generatedMdx) {
    const typedContent = generatedMdx.source
      .replace(
        "function _createMdxContent(props) {",
        "function _createMdxContent(props: { components: __ReviewComponents }) {",
      )
      .replace("\n  }, {", "\n  } as const, {")
      .replace("\n  };\n  return", "\n  } as const;\n  return");
    generatedRegion = {
      virtualStartLine: nextVirtualLine,
      virtualEndLine: nextVirtualLine + countLines(typedContent) - 1,
      runtimeStartLine: generatedMdx.runtimeStartLine,
    };
    sourceParts.push(typedContent);
  }
  const virtualSource = sourceParts.join("\n");
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
    paths: reviewReactTypePaths(),
  };
  const host = ts.createCompilerHost(options);
  const moduleResolutionCache = ts.createModuleResolutionCache(
    process.cwd(),
    host.getCanonicalFileName,
    options,
  );
  host.resolveModuleNameLiterals = (
    moduleLiterals,
    containingFile,
    redirectedReference,
    compilerOptions,
    containingSourceFile,
  ) =>
    moduleLiterals.map((moduleLiteral) =>
      ts.resolveModuleName(
        viteFsModulePath(moduleLiteral.text),
        containingFile,
        compilerOptions,
        host,
        moduleResolutionCache,
        redirectedReference,
        ts.getModeForUsageLocation(
          containingSourceFile,
          moduleLiteral,
          compilerOptions,
        ),
      ),
    );
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    if (path.resolve(fileName) === path.resolve(virtualFilePath)) {
      return ts.createSourceFile(
        virtualFilePath,
        virtualSource,
        languageVersion,
        true,
        ts.ScriptKind.TSX,
      );
    }
    return originalGetSourceFile(
      fileName,
      languageVersion,
      onError,
      shouldCreate,
    );
  };
  const originalFileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) =>
    path.resolve(fileName) === path.resolve(virtualFilePath) ||
    originalFileExists(fileName);
  const originalReadFile = host.readFile.bind(host);
  host.readFile = (fileName) =>
    path.resolve(fileName) === path.resolve(virtualFilePath)
      ? virtualSource
      : originalReadFile(fileName);

  const program = ts.createProgram([virtualFilePath], options, host);
  return mapTypescriptDiagnostics({
    authoredFilePath: input.filePath,
    virtualFilePath,
    regions,
    generatedRegion,
    runtimeMap,
    diagnostics: ts.getPreEmitDiagnostics(program),
  });
}

function reviewReactTypePaths() {
  const reactTypesRoot = path.dirname(
    require.resolve("@types/react/package.json"),
  );
  return {
    react: [path.join(reactTypesRoot, "index.d.ts")],
    "react/jsx-runtime": [path.join(reactTypesRoot, "jsx-runtime.d.ts")],
    "react/jsx-dev-runtime": [
      path.join(reactTypesRoot, "jsx-dev-runtime.d.ts"),
    ],
  };
}

function viteFsModulePath(moduleName: string): string {
  if (moduleName.startsWith("/@fs/")) {
    return moduleName.slice("/@fs/".length);
  }
  if (moduleName.startsWith("/src/")) {
    return path.join(reviewAppSourcePath(), moduleName.slice("/src/".length));
  }
  return moduleName;
}

function reviewModuleResolutionCandidates(
  moduleName: string,
  containingFile: string,
): string[] {
  if (
    moduleName === "@dev.fast/review/authoring" ||
    moduleName === "virtual:progressive-review-authoring"
  ) {
    return [normalizeViteModuleFilePath(resolveAuthoringSourcePath())];
  }

  const vitePath = viteFsModulePath(moduleName);
  const isLocal =
    moduleName.startsWith("./") ||
    moduleName.startsWith("../") ||
    moduleName.startsWith("/src/") ||
    moduleName.startsWith("/@fs/") ||
    path.isAbsolute(vitePath);
  if (!isLocal) return [];

  const basePath = path.resolve(
    path.isAbsolute(vitePath)
      ? vitePath
      : path.resolve(path.dirname(containingFile), vitePath),
  );
  const extension = path.extname(basePath);
  if (extension) {
    const candidates = [basePath];
    const typescriptExtension = typescriptSourceExtension(extension);
    if (typescriptExtension) {
      candidates.unshift(
        `${basePath.slice(0, -extension.length)}${typescriptExtension}`,
      );
    }
    return [
      ...new Set(
        candidates.map((candidate) => normalizeViteModuleFilePath(candidate)),
      ),
    ];
  }

  return [
    ...reviewModuleExtensions.map((candidate) => `${basePath}${candidate}`),
    ...reviewModuleExtensions.map((candidate) =>
      path.join(basePath, `index${candidate}`),
    ),
  ].map((candidate) => normalizeViteModuleFilePath(candidate));
}

function typescriptSourceExtension(extension: string): string | null {
  switch (extension) {
    case ".js":
      return ".ts";
    case ".jsx":
      return ".tsx";
    case ".mjs":
      return ".mts";
    case ".cjs":
      return ".cts";
    default:
      return null;
  }
}

async function mapTypescriptDiagnostics(input: {
  authoredFilePath: string;
  virtualFilePath: string;
  regions: AuthoredTypescriptRegion[];
  generatedRegion: GeneratedMdxRegion | undefined;
  runtimeMap: RawSourceMap | undefined;
  diagnostics: readonly ts.Diagnostic[];
}): Promise<ReviewDocumentDiagnostic[]> {
  const consumer = input.runtimeMap
    ? await new SourceMapConsumer(input.runtimeMap)
    : null;
  try {
    const results: ReviewDocumentDiagnostic[] = [];
    for (const diagnostic of input.diagnostics) {
      results.push(...typescriptDiagnostic(input, diagnostic, consumer));
    }
    return deduplicateDiagnostics(results);
  } finally {
    consumer?.destroy();
  }
}

function deduplicateDiagnostics(
  diagnostics: ReviewDocumentDiagnostic[],
): ReviewDocumentDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = [
      diagnostic.source,
      diagnostic.code,
      diagnostic.filePath,
      diagnostic.line,
      diagnostic.column,
      diagnostic.message,
    ].join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function typescriptDiagnostic(
  input: Omit<Parameters<typeof mapTypescriptDiagnostics>[0], "diagnostics">,
  diagnostic: ts.Diagnostic,
  consumer: Awaited<ReturnType<typeof createSourceMapConsumer>> | null,
): ReviewDocumentDiagnostic[] {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (!diagnostic.file || diagnostic.start === undefined) {
    return diagnostic.category === ts.DiagnosticCategory.Error
      ? [
          {
            source: "typescript",
            severity: "error",
            code: `TS${diagnostic.code}`,
            message,
            filePath: input.authoredFilePath,
          },
        ]
      : [];
  }
  if (
    path.resolve(diagnostic.file.fileName) !==
    path.resolve(input.virtualFilePath)
  ) {
    return [];
  }
  const position = diagnostic.file.getLineAndCharacterOfPosition(
    diagnostic.start,
  );
  const virtualLine = position.line + 1;
  const region = input.regions.find(
    (candidate) =>
      candidate.virtualStartLine !== undefined &&
      candidate.virtualEndLine !== undefined &&
      virtualLine >= candidate.virtualStartLine &&
      virtualLine <= candidate.virtualEndLine,
  );
  const isGeneratedMdxDiagnostic = Boolean(
    input.generatedRegion &&
    virtualLine >= input.generatedRegion.virtualStartLine &&
    virtualLine <= input.generatedRegion.virtualEndLine,
  );
  let sourceLine: number | undefined;
  let sourceColumn: number | undefined;
  if (region?.virtualStartLine !== undefined) {
    sourceLine =
      region.sourceStartLine + (virtualLine - region.virtualStartLine);
    sourceColumn =
      position.character +
      1 +
      (virtualLine === region.virtualStartLine
        ? region.sourceStartColumn - 1
        : 0);
  } else if (consumer && input.generatedRegion && isGeneratedMdxDiagnostic) {
    let original = consumer.originalPositionFor({
      line:
        input.generatedRegion.runtimeStartLine +
        (virtualLine - input.generatedRegion.virtualStartLine),
      column: position.character,
    });
    if (original.line === null) {
      original = consumer.originalPositionFor({
        line:
          input.generatedRegion.runtimeStartLine +
          (virtualLine - input.generatedRegion.virtualStartLine),
        column: position.character,
        bias: SourceMapConsumer.LEAST_UPPER_BOUND,
      });
    }
    sourceLine = original.line ?? undefined;
    sourceColumn =
      original.column === null || original.column === undefined
        ? undefined
        : original.column + 1;
  }
  if (sourceLine === undefined && !isGeneratedMdxDiagnostic) return [];
  return [
    {
      source: "typescript",
      severity:
        diagnostic.category === ts.DiagnosticCategory.Error
          ? "error"
          : "warning",
      code: `TS${diagnostic.code}`,
      message,
      filePath: input.authoredFilePath,
      ...(sourceLine === undefined ? {} : { line: sourceLine }),
      ...(sourceColumn === undefined ? {} : { column: sourceColumn }),
    },
  ];
}

function createSourceMapConsumer(map: RawSourceMap) {
  return new SourceMapConsumer(map);
}

function extractGeneratedMdxContent(
  runtimeCode: string,
): { source: string; runtimeStartLine: number } | null {
  const startMarker = "function _createMdxContent";
  const endMarker = "export default function MDXContent";
  const start = runtimeCode.indexOf(startMarker);
  const end = runtimeCode.indexOf(endMarker, start);
  if (start < 0 || end < 0) return null;
  return {
    source: runtimeCode.slice(start, end).trimEnd(),
    runtimeStartLine: countLines(runtimeCode.slice(0, start)),
  };
}

function resolveAuthoringSourcePath(): string {
  return progressiveReviewAuthoringSourcePath(import.meta.url);
}

function reviewAppSourcePath(): string {
  return progressiveReviewAppSourcePath(import.meta.url);
}

function rewriteAuthoringModuleSpecifier(
  source: string,
  authoringPath: string,
): string {
  const withoutVirtualImports = source.replaceAll(
    /import\s*\{[^}]*\}\s*from\s*(["'])virtual:progressive-review-authoring\1\s*;?/g,
    (statement) => statement.replace(/[^\r\n]/g, " "),
  );
  return withoutVirtualImports.replaceAll(
    /(["'])@dev\.fast\/review\/authoring\1/g,
    JSON.stringify(authoringPath),
  );
}

function countLines(value: string): number {
  return value.split(/\r\n|\n|\r/).length;
}

function walkMdast(node: MdastNode, visit: (node: MdastNode) => void): void {
  visit(node);
  if ("children" in node) {
    for (const child of node.children) walkMdast(child, visit);
  }
}

// Every estree node carries a string `type`; the other objects hanging off a
// node (`loc`, a literal's `regex`, ...) do not.
const estreeNodeSchema = z.object({ type: z.string() });

function isEstreeNode(value: EstreeValue): value is EstreeNode {
  return estreeNodeSchema.safeParse(value).success;
}

function eraseTypescriptRecma() {
  return (tree: EstreeNode) => {
    const erased = eraseTypescriptNode(tree);
    if (erased && erased !== tree) Object.assign(tree, erased);
  };
}

function eraseTypescriptNode(value: EstreeValue): EstreeValue {
  if (Array.isArray(value)) {
    return value
      .map((entry) => eraseTypescriptNode(entry))
      .filter((entry) => entry !== null);
  }
  if (!isEstreeNode(value)) return value;

  const node = value;
  if (
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSTypeAssertion" ||
    node.type === "TSNonNullExpression" ||
    node.type === "TSInstantiationExpression"
  ) {
    return eraseTypescriptNode(node.expression);
  }
  if (node.type?.startsWith("TS")) return null;

  if (node.type === "ImportDeclaration") {
    if (node.importKind === "type") return null;
    if (Array.isArray(node.specifiers)) {
      node.specifiers = node.specifiers.filter(
        (specifier) =>
          !isEstreeNode(specifier) || specifier.importKind !== "type",
      );
    }
  }
  if (node.type === "ExportNamedDeclaration" && node.exportKind === "type") {
    return null;
  }

  for (const property of [
    "typeAnnotation",
    "typeParameters",
    "returnType",
    "typeArguments",
    "superTypeParameters",
    "implements",
    "declare",
    "definite",
    "abstract",
    "accessibility",
    "readonly",
  ]) {
    delete node[property];
  }

  for (const [property, child] of Object.entries(node)) {
    if (property === "loc" || property === "range" || property === "extra") {
      continue;
    }
    node[property] = eraseTypescriptNode(child);
  }
  return node;
}

function mdxDiagnostic(
  filePath: string,
  cause: unknown,
): ReviewDocumentDiagnostic {
  const candidate = cause as {
    message?: string;
    line?: number;
    column?: number;
    place?: { start?: { line?: number; column?: number } };
  };
  return {
    source: "mdx",
    severity: "error",
    code: "MDX_PARSE_ERROR",
    message: candidate?.message ?? String(cause),
    filePath,
    line: candidate?.line ?? candidate?.place?.start?.line,
    column: candidate?.column ?? candidate?.place?.start?.column,
  };
}
