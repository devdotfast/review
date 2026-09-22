import { type JsonValue, isObjectValue, isStringValue } from "@dev.fast/json";

import { ReviewInputError } from "./document.js";

export type ApiVocabulary = "review" | "session";

/** Translate only API-owned metadata, never nested documents or resources. */
export function presentId<T extends object>(
  value: T,
  vocabulary: ApiVocabulary,
) {
  if (
    vocabulary === "review" ||
    !("reviewId" in value) ||
    !isStringValue(value.reviewId)
  )
    return value;
  const { reviewId, ...rest } = value;

  return { ...rest, sessionId: reviewId };
}

/** Normalize before validation and receipt comparison so retries keep their identity. */
export function acceptId(value: JsonValue, vocabulary: ApiVocabulary) {
  if (vocabulary === "review" || !isObjectValue(value)) return value;

  if ("reviewId" in value)
    throw new ReviewInputError("Use sessionId instead of reviewId.");

  if (!("sessionId" in value)) return value;
  const { sessionId, ...rest } = value;

  return { ...rest, reviewId: sessionId };
}

export function acceptCommand(value: JsonValue, vocabulary: ApiVocabulary) {
  if (!isObjectValue(value) || !("operation" in value)) return value;

  return { ...value, operation: acceptId(value.operation, vocabulary) };
}
