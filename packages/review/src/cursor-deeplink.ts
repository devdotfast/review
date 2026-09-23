/** Cursor's one-click MCP install link for Whiteboard's server. */
export function cursorInstallDeeplink(launch: {
  command: string;
  args: string[];
}): string {
  const config = Buffer.from(
    JSON.stringify({ command: launch.command, args: launch.args }),
  ).toString("base64");

  return `cursor://anysphere.cursor-deeplink/mcp/install?name=whiteboard&config=${encodeURIComponent(config)}`;
}
