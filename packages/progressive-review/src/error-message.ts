export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
