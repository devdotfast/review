/**
 * Realm-safe primitive checks. This module is the one sanctioned home for
 * `typeof`; every other decoder in the repo narrows through these predicates.
 * `instanceof Object` is not a substitute: values created in another realm
 * (a worker, a vm context, an iframe) fail it while `typeof` still answers.
 */
export function isStringValue(value: unknown): value is string {
  return typeof value === "string";
}

export function isNumberValue(value: unknown): value is number {
  return typeof value === "number";
}

export function isBooleanValue(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** A non-null object, arrays and functions excluded. */
export function isObjectValue(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

export function isCallableValue(
  value: unknown,
): value is (...args: never[]) => void {
  return typeof value === "function";
}
