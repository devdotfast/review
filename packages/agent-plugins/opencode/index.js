/** Registers dev.fast Whiteboard's MCP server. Requires Whiteboard Desktop with the whiteboard command installed. */
export default async function whiteboardPlugin() {
  return {
    config: async (config) => {
      config.mcp = {
        ...config.mcp,
        whiteboard: {
          type: "local",
          // Windows has no sh; cmd finds whiteboard.cmd on PATH.
          command:
            process.platform === "win32"
              ? ["cmd", "/d", "/c", "whiteboard", "mcp"]
              : ["sh", "-c", 'exec "$HOME/.local/bin/whiteboard" mcp'],
          enabled: true,
        },
      };
    },
  };
}
