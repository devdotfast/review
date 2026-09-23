# Whiteboard workflow

1. Install Whiteboard Desktop; it installs the `whiteboard` CLI.
2. Open Whiteboard Desktop. It hosts the JSON whiteboard server for this workflow.
3. Run `whiteboard connect <agent>` and paste its prompt into the agent; the
   agent adds the Whiteboard MCP server, which serves the authoring instructions.
4. Ask the agent for a whiteboard. It authors the whiteboard through the Whiteboard MCP
   tools or `whiteboard api`.
