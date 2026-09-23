---
name: whiteboard
description: "Explain code in Whiteboard, the architecture-visualization tool: author Whiteboards of branches, changes and pull requests, draw on the Whiteboard scratchpad, or research why code exists from past agent sessions."
---

# dev.fast Whiteboard

Whiteboard serves its own instructions over the `whiteboard` MCP server. Before authoring, call `session_get_instructions` and follow it. Pass `{"topic":"scratchpad"}` to explain code visually, or `{"topic":"trace-archaeology"}` to research why code exists. If the tools are missing, reload the `whiteboard` MCP server or ask the user to start Whiteboard Desktop.
