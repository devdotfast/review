import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ScriptKind,
  ScriptTarget,
  createSourceFile,
  isExportDeclaration,
  isImportDeclaration,
  isNamedExports,
  isNamedImports,
  isStringLiteral,
  isTypeOnlyImportOrExportDeclaration,
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
  const base = path.resolve(path.dirname(fromFile), specifier);

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(path.dirname(base), path.basename(base, path.extname(base))),
    `${path.join(path.dirname(base), path.basename(base, path.extname(base)))}.ts`,
    `${path.join(path.dirname(base), path.basename(base, path.extname(base)))}.tsx`,
    path.join(base, "index.ts"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }

  throw new Error(
    `Cannot resolve ${specifier} from ${path.relative(SRC_DIR, fromFile)}`,
  );
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
    if (isImportDeclaration(statement)) {
      const clause = statement.importClause;

      if (
        !isStringLiteral(statement.moduleSpecifier) ||
        clause?.isTypeOnly ||
        isTypeOnlyImportOrExportDeclaration(statement) ||
        (!clause?.name &&
          clause?.namedBindings &&
          isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly))
      ) {
        continue;
      }

      specifiers.push(statement.moduleSpecifier.text);
      continue;
    }

    if (!isExportDeclaration(statement) || !statement.moduleSpecifier) continue;

    if (
      !isStringLiteral(statement.moduleSpecifier) ||
      statement.isTypeOnly ||
      isTypeOnlyImportOrExportDeclaration(statement) ||
      (statement.exportClause &&
        isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.length > 0 &&
        statement.exportClause.elements.every((element) => element.isTypeOnly))
    ) {
      continue;
    }

    specifiers.push(statement.moduleSpecifier.text);
  }

  return specifiers;
}

interface ImportClosure {
  modules: string[];
  packages: string[];
}

function staticImportClosure(roots: string[]): ImportClosure {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const queue = roots.map((root) => path.join(SRC_DIR, root));

  while (queue.length > 0) {
    const file = queue.shift();

    if (file === undefined || seen.has(file)) continue;
    seen.add(file);

    for (const specifier of staticImportSpecifiers(file)) {
      if (!specifier.startsWith(".")) {
        packages.add(specifier);
        continue;
      }

      queue.push(resolveRelativeImport(file, specifier));
    }
  }

  const modules = [...seen].map((file) => path.relative(SRC_DIR, file)).sort();

  return { modules, packages: [...packages].sort() };
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
