import { z } from "zod";

import { HostIdSchema, HostTimeSchema } from "./host-document.js";

/** Transient host observations, never part of document revisions or history. */
export const HostActivitySnapshotSchema = z.strictObject({
  reviewId: HostIdSchema,
  workingCount: z.number().int().nonnegative(),
  unknownCount: z.number().int().nonnegative(),
});
export type HostActivitySnapshot = z.infer<typeof HostActivitySnapshotSchema>;

const session = z.strictObject({
  reviewId: HostIdSchema,
  activityId: HostIdSchema,
});
const lease = z.strictObject({
  activityId: HostIdSchema,
  expiresAt: HostTimeSchema,
});

export const HOST_ACTIVITY_COMMANDS = {
  "authoring.begin": { permission: "author", input: session, result: lease },
  "authoring.renew": { permission: "author", input: session, result: lease },
  "authoring.end": {
    permission: "author",
    input: session,
    result: z.strictObject({ accepted: z.literal(true) }),
  },
} as const;

export const HOST_ACTIVITY_QUERIES = {
  "authoring.get": {
    permission: "read",
    input: z.strictObject({ reviewId: HostIdSchema }),
    result: HostActivitySnapshotSchema,
  },
} as const;
