import { fileURLToPath } from "node:url";

export const reviewTestAliases = {
  "@dev.fast/review-share-protocol": fileURLToPath(
    new URL("../review-share-protocol/src/index.ts", import.meta.url),
  ),
  "@dev.fast/trace-core": fileURLToPath(
    new URL("../trace-core/src/index.ts", import.meta.url),
  ),
  "@dev.fast/json": fileURLToPath(
    new URL("../json/src/index.ts", import.meta.url),
  ),
  "@dev.fast/local-vcs": fileURLToPath(
    new URL("../local-vcs/src/index.ts", import.meta.url),
  ),
  "@dev.fast/review-protocol": fileURLToPath(
    new URL("../review-protocol/src/index.ts", import.meta.url),
  ),
  // review-protocol's source imports trace-protocol directly; without this
  // alias, Vite falls through to node_modules and needs trace-protocol's
  // `dist` built (see Task 3's from-source lanes).
  "@dev.fast/trace-protocol": fileURLToPath(
    new URL("../trace-protocol/src/index.ts", import.meta.url),
  ),
};
