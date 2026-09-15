import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ModuleResolutionKind,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  createSourceFile,
  forEachChild,
  isCallExpression,
  isExportDeclaration,
  isImportDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isNamedExports,
  isNamedImports,
  isStringLiteral,
  resolveModuleName,
  sys,
} from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The trace surface must stay free of the Review app's state store, VCS
 * engine, and desktop installer so a standalone trace CLI can bundle it.
 * These roots are the modules such a CLI imports. The walk follows static
 * value imports only: `import type`, `export type`, and `import()` are not
 * part of a bundle's eager graph.
 */
const TRACE_ROOTS = ["index.ts"];

/** Source-relative module paths the closure must never contain. */
const FORBIDDEN_MODULES = [
  "trace-cli.ts",
  "trace-storage/s3.ts",
  "tutorial-trace.ts",
  "review-home.ts",
  "review-state-store.ts",
  "review-vcs.ts",
  "review-head-checkout.ts",
  "review-worktree-target.ts",
  "server/cli-install.ts",
  "install.ts",
  "review-telemetry.ts",
  "startup-trace.ts",
];

const FORBIDDEN_PACKAGES = [
  "@dev.fast/review",
  "isomorphic-git",
  "react",
  "node:sqlite",
];

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

function resolveRelativeImport(fromFile: string, specifier: string): string {
  const resolved = resolveModuleName(
    specifier,
    fromFile,
    { moduleResolution: ModuleResolutionKind.Bundler },
    sys,
  ).resolvedModule;

  if (resolved) return resolved.resolvedFileName;
  throw new Error(`Cannot resolve ${specifier} from ${fromFile}`);
}

/** Static import specifiers of one file; type-only imports are skipped. */
function staticImportSpecifiers(file: string): string[] {
  const sourceFile = createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ScriptTarget.Latest,
    false,
    file.endsWith(".tsx") ? ScriptKind.TSX : ScriptKind.TS,
  );

  const specifiers: string[] = [];

  for (const statement of sourceFile.statements) {
    if (
      !(isImportDeclaration(statement) || isExportDeclaration(statement)) ||
      !statement.moduleSpecifier ||
      !isStringLiteral(statement.moduleSpecifier)
    )
      continue;

    const clause = isImportDeclaration(statement)
      ? statement.importClause
      : statement;

    if (clause?.isTypeOnly) continue;

    const bindings = isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : statement.exportClause;

    const hasDefault =
      isImportDeclaration(statement) && statement.importClause?.name;

    if (
      !hasDefault &&
      bindings &&
      (isNamedImports(bindings) || isNamedExports(bindings)) &&
      bindings.elements.length > 0 &&
      bindings.elements.every((element) => element.isTypeOnly)
    )
      continue;

    specifiers.push(statement.moduleSpecifier.text);
  }

  return specifiers;
}

function staticImportClosure(roots: string[]) {
  const modules = new Set(roots.map((root) => path.join(SRC_DIR, root)));
  const packages = new Set<string>();

  // Set iteration also visits dependencies added during the walk.
  for (const file of modules) {
    for (const specifier of staticImportSpecifiers(file)) {
      if (specifier.startsWith(".")) {
        modules.add(resolveRelativeImport(file, specifier));
      } else {
        packages.add(specifier);
      }
    }
  }

  return {
    modules: [...modules].map((file) => path.relative(SRC_DIR, file)).sort(),
    packages: [...packages].sort(),
  };
}

describe("trace surface import closure", () => {
  const closure = staticImportClosure(TRACE_ROOTS);
  process.stdout.write(`trace closure: ${closure.modules.length} modules\n`);

  if (process.env.TRACE_CLOSURE_PRINT === "1") {
    // Eager imports only; lazy runtime dependencies need a separate inventory.
    process.stdout.write(`${closure.modules.join("\n")}\n`);
  }

  it("does not reach the Review app's store, VCS engine, or installer", () => {
    const reached = FORBIDDEN_MODULES.filter((module) =>
      closure.modules.includes(module),
    );

    expect(reached).toEqual([]);
  });

  it("does not import isomorphic-git, react, or node:sqlite", () => {
    const reached = FORBIDDEN_PACKAGES.filter((name) =>
      closure.packages.includes(name),
    );

    expect(reached).toEqual([]);
  });
});

/** Includes type and deferred imports when checking package independence. */
function allImportSpecifiers(file: string, source: string): string[] {
  const parsed = createSourceFile(
    file,
    source,
    ScriptTarget.Latest,
    false,
    ScriptKind.TS,
  );

  const specifiers: string[] = [];

  function visit(node: import("typescript").Node): void {
    if (
      (isImportDeclaration(node) || isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      isCallExpression(node) &&
      node.expression.kind === SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    } else if (
      isImportTypeNode(node) &&
      isLiteralTypeNode(node.argument) &&
      isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    }

    forEachChild(node, visit);
  }

  visit(parsed);

  return specifiers;
}

function boundaryViolations(file: string, source: string): string[] {
  return allImportSpecifiers(file, source).filter((specifier) => {
    if (
      FORBIDDEN_PACKAGES.some(
        (name) => specifier === name || specifier.startsWith(`${name}/`),
      )
    )
      return true;

    if (!specifier.startsWith(".")) return false;
    const resolved = path.resolve(path.dirname(file), specifier);

    return !resolved.startsWith(`${SRC_DIR}${path.sep}`);
  });
}

describe("trace-core package independence", () => {
  it("has no Review or app dependency, including deferred and type-only edges", () => {
    const violations: string[] = [];

    for (const relative of readdirSync(SRC_DIR, {
      recursive: true,
      encoding: "utf8",
    })) {
      if (!relative.endsWith(".ts")) continue;
      const file = path.join(SRC_DIR, relative);

      for (const specifier of boundaryViolations(
        file,
        readFileSync(file, "utf8"),
      )) {
        violations.push(`${path.relative(SRC_DIR, file)}: ${specifier}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("rejects Review subpaths, lazy imports and type-only relative backedges", () => {
    const file = path.join(SRC_DIR, "negative-control.ts");
    expect(
      boundaryViolations(
        file,
        `
      import type { App } from "@dev.fast/review";
      export type { App } from "@dev.fast/review/authoring";
      const app = import("../../review/src/runtime");
      type AppType = import("../../review/src/authoring").App;
    `,
      ),
    ).toEqual([
      "@dev.fast/review",
      "@dev.fast/review/authoring",
      "../../review/src/runtime",
      "../../review/src/authoring",
    ]);
  });
});
