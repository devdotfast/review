# SoftwareMap Renderer Shell

This folder is intentionally isolated from the MDX component registry.
`SoftwareMap.tsx` renders objective inline C4 models and explicit C4-shaped
snapshots. Authored named views are not part of the public model; the C4 surface
derives visible nodes from root systems/people plus `expandedNodeIds`.

## Current Shell

- `SoftwareMap` renders an inline article-flow map frame with a compact header,
  inline C4 chip, placeholder state, and relationship summary.
- The top-right expand control is present in the DOM but revealed on frame
  hover or focus.
- The fullscreen overlay reuses the same `SoftwareMapFrame` renderer as the
  inline surface. Expansion only changes available space.
- Model compilation, inline projection, and local layout are integrated here.
  Code elements stay on the C4 canvas; selecting one opens the
  side inspector backed by `CodePeek`.
