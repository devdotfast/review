// node: imports only. This module runs before the bundle loads, so it must
// never pull the library in.

export const NODE_FLOOR_MAJOR = 22;

/** True when a `process.versions.node` value meets the floor. */
export function supportedNodeRuntime(version: string): boolean {
  const major = Number(version.split(".")[0]);

  return Number.isInteger(major) && major >= NODE_FLOOR_MAJOR;
}

/** The one line an unsupported Node runtime gets on stderr. */
export function nodeFloorMessage(version: string): string {
  return `dev-traces needs Node.js ${NODE_FLOOR_MAJOR} or newer; found ${version}. Install Node ${NODE_FLOOR_MAJOR} and rerun.\n`;
}
