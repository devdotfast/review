import { z } from "zod";

export const sessionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/);

export const commitShaSchema = z.string().regex(/^[0-9a-f]{40,64}$/);
