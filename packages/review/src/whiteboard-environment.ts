/** New public names select the same profile during the naming migration. */
export function whiteboardEnvironment(env: NodeJS.ProcessEnv) {
  const result = { ...env };

  for (const suffix of ["HOME", "SERVER_DIR", "SHARE_TOKEN"] as const) {
    const value = env[`DEV_WHITEBOARD_${suffix}`];

    if (value !== undefined) result[`DEV_REVIEW_${suffix}`] = value;
  }

  return result;
}
