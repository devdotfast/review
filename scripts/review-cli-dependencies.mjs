// Audit the installed tree, including transitive dependencies, before publishing.
const developmentTool =
  /^(?:@playwright\/|@vitest\/|@vitejs\/|@electron\/|playwright(?:-core)?$|vitest$|vite$|electron$|tsdown$|tsx$|typescript$|esbuild$|@esbuild\/|@rolldown\/|rolldown$)/;

export function checkProductionDependencies(tree) {
  const packages = new Set();

  function visit(node, ancestors) {
    for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
      const chain = [...ancestors, name];

      if (developmentTool.test(name))
        throw new Error(
          `Development tooling in CLI production dependencies: ${chain.join(" -> ")}`,
        );

      if (dependency.version) packages.add(`${name}@${dependency.version}`);
      visit(dependency, chain);
    }
  }

  visit(tree, []);

  return packages.size;
}
