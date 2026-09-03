import { z } from "zod";

// Minimal contract values needed by store-api.ts. The dev repo's
// packages/trace-shared/src/contracts.ts carries the full trace-product
// contract (apps/trace, apps/web token minting); the review repo only
// needs the store API, so only the schemas store-api.ts imports live here.
// Keep these two definitions byte-identical with the dev repo's copies.

export const sessionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/);

export const commitShaSchema = z.string().regex(/^[0-9a-f]{40,64}$/);
