/** Regenerated or process-local state under a review directory. Never
 * fingerprinted, copied into a candidate, or sealed. */
export function isDerivedWhiteboardPath(name: string): boolean {
  return (
    name === ".build" ||
    name === ".native-agent" ||
    name === ".agent-sessions.lock" ||
    /^review\.db(?:-|$)/.test(name)
  );
}

const MANAGED_WHITEBOARD_NAMES = new Set([
  "node_modules",
  "review.json",
  ".git",
  ".bundle",
]);

/** Durable authored bytes: the inputs a publication or repair candidate is
 * rebuilt from. Excludes derived state and the artifacts, record and private
 * history that every writer manages explicitly. */
export function isAuthoringInput(name: string): boolean {
  return !isDerivedWhiteboardPath(name) && !MANAGED_WHITEBOARD_NAMES.has(name);
}
