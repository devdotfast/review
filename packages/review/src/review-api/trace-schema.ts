import { z } from "zod";

export const traceSchema = z.strictObject({
  label: z.string(),
  events: z.array(
    z.strictObject({
      id: z.string().min(1),
      role: z.enum(["user", "assistant", "tool"]),
      text: z.string(),
    }),
  ),
  provenance: z.enum(["client_supplied", "legacy_import"]).optional(),
});
