/** Registers dev.fast Whiteboard's MCP server. Requires Whiteboard Desktop with the whiteboard command installed. */
export default async function whiteboardPlugin() {
  return {
    config: async (config) => {
      config.mcp = {
        ...config.mcp,
        whiteboard: {
          type: "local",
          command: ["sh", "-c", 'exec "$HOME/.local/bin/whiteboard" mcp'],
          enabled: true,
        },
      };
    },
  };
}
