import { fileURLToPath } from "node:url";

export const whiteboardTestAliases = {
  "@dev.fast/whiteboard-share-protocol": fileURLToPath(
    new URL("../whiteboard-share-protocol/src/index.ts", import.meta.url),
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
  "@dev.fast/whiteboard-protocol": fileURLToPath(
    new URL("../whiteboard-protocol/src/index.ts", import.meta.url),
  ),
  // review-protocol's source imports trace-protocol directly; without this
  // alias, Vite falls through to node_modules and needs trace-protocol's
  // `dist` built (see Task 3's from-source lanes).
  "@dev.fast/trace-protocol": fileURLToPath(
    new URL("../trace-protocol/src/index.ts", import.meta.url),
  ),
};
