---
name: dev-review
description: Explain code in Review, the architecture-visualization tool: author Reviews of branches, changes and pull requests, draw on the Review scratchpad, or research why code exists from past agent sessions.
metadata:
  review-managed-by: "Review Desktop"
  review-generated: "Do not edit. Review automatically replaces this skill directory on updates."
  review-version: "development"
---

# dev.fast Review

Review serves its own instructions. Before authoring, read them from the running Review server and follow them:

- With Review MCP tools: call `review_get_instructions({})`.
- Otherwise: `review api review_get_instructions '{}'`.

Pass `{"topic":"scratchpad"}` to explain code visually, or `{"topic":"trace-archaeology"}` to research why code exists. If Review is not running, the response says how to start it.
