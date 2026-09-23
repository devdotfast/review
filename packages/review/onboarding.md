# Review workflow

1. Install Whiteboard Desktop; it installs the `review` CLI.
2. Open Whiteboard Desktop. It hosts the JSON review server for this workflow.
3. Run `whiteboard connect <agent>` and paste its prompt into the agent; the
   agent adds the Review MCP server, which serves the authoring instructions.
4. Ask the agent for a review. It authors the review through the Review MCP
   tools or `whiteboard api`.
