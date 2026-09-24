---
name: whiteboard
description: "Explain code in Whiteboard, the architecture-visualization tool: author Whiteboards of branches, changes and pull requests, draw on the Whiteboard scratchpad, or research why code exists from past agent sessions."
---

# dev.fast Whiteboard

Whiteboard serves its own instructions. Before authoring, run `whiteboard api session_get_instructions '{}'` and follow the result. Pass `'{"topic":"scratchpad"}'` to explain code visually, or `'{"topic":"trace-archaeology"}'` to research why code exists. If Whiteboard is not running, the response says how to start it.
