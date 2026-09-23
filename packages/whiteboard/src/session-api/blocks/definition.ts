import { z } from "zod";

import { SessionInputError } from "../input-error.js";

export const text = z.string();

export const label = text.trim().min(1);

export const identity = { id: text.optional() };

/**
 * One block kind: the strict schema the store parses with, and the rules a
 * field schema cannot express. `check` throws SessionInputError.
 */
export interface BlockDefinition<Content extends { type: string }> {
  type: Content["type"];
  schema: z.ZodType<Content>;
  check?(block: Content): void;
}

/** The strict schema for a block's own fields; id and type are added here. */
export function defineBlock<
  Type extends string,
  Props extends Record<string, z.ZodType>,
>(type: Type, props: Props) {
  return z.strictObject({ ...identity, type: z.literal(type), ...props });
}

/** Shared by every check that resolves a component-local name. */
export function requireKey<T>(record: Record<string, T>, name: string): void {
  if (!Object.hasOwn(record, name))
    throw new SessionInputError(`Unknown component name: ${name}`);
}
