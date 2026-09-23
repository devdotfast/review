---
name: whiteboard
description: Explain code in Whiteboard sessions, author reviews of changes and pull requests, or draw on the Whiteboard scratchpad.
metadata:
  whiteboard-managed-by: "Whiteboard"
  whiteboard-generated: "Do not edit. Whiteboard automatically replaces this skill directory on updates."
  whiteboard-version: "development"
---

# Whiteboard

Before authoring, read and follow the instructions served by the running Whiteboard server:

- With Whiteboard MCP tools, call `session_get_instructions({})`.
- Otherwise, run `whiteboard api session_get_instructions '{}'`.

Pass `{"topic":"scratchpad"}` to explain code visually or `{"topic":"trace-archaeology"}` to research why code exists. If Whiteboard is not running, start Whiteboard Desktop or `whiteboard server start` for headless use.
