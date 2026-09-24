/** Listed by the MCP adapter even while no Desktop is reachable. Its public
 * name is kept: it names the app instance, not a session. */
export const REVIEW_STATUS_TOOL = {
  name: "whiteboard_status",
  description:
    "Name the Whiteboard instance this session talks to: key (stable, preview or dev-<checkout>), channel, checkout, appVersion, cliVersion, instanceId, url, home and desktopAvailable. Call it before changing anything when the user mentions Preview, a checkout or a dev build.",
  inputSchema: { type: "object" as const, properties: {} },
  method: "GET" as const,
  path: "/status",
};
