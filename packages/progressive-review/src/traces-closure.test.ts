import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ModuleResolutionKind,
  ScriptKind,
  ScriptTarget,
  createSourceFile,
  isExportDeclaration,
  isImportDeclaration,
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
const TRACE_ROOTS = [
  "trace-capture-cli.ts",
  "trace-read-cli.ts",
  "store-auth.ts",
  "trace-hosted-cli.ts",
  "trace-hook-runner.ts",
  "trace-git-hook-runner.ts",
  "agent-trace-hooks.ts",
  "trace-repository-hooks.ts",
  "cli-output.ts",
  "trace-storage/resolve.ts",
];

/** Source-relative module paths the closure must never contain. */
const FORBIDDEN_MODULES = [
  "trace-cli.ts",
  "review-home.ts",
  "review-state-store.ts",
  "review-vcs.ts",
  "review-head-checkout.ts",
  "review-worktree-target.ts",
  "server/cli-install.ts",
  "install.ts",
  "progressive-review-telemetry.ts",
  "startup-trace.ts",
];

const FORBIDDEN_PACKAGES = ["isomorphic-git", "react", "node:sqlite"];

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
