import { configDefaults, defineConfig } from "vitest/config";

const isolatedTests = ["src/index.cache.test.ts"];

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "shared-module-graph",
          environment: "node",
          isolate: false,
          exclude: [...configDefaults.exclude, ...isolatedTests],
        },
      },
      {
        extends: true,
        test: {
          name: "isolated",
          environment: "node",
          include: isolatedTests,
        },
      },
    ],
  },
});
