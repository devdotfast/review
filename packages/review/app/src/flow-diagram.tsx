import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import type { FlowDiagramBlock } from "../../src/review-api/blocks/flow_diagram";
import type { Snapshot } from "../../src/review-api/store";
import { DiagramHeader } from "./diagram-header";
import { DiagramTourOverlay, useDiagramTourShell } from "./diagram-tour";
import { FlowGraph } from "./flow-graph";
import type { GuidedTour, GuidedTourStop } from "./review-panel-model";

import "./flow-diagram.css";

/** Each attachment is a tour stop; selection still belongs to its graph node. */
export function flowTourStops(
  block: FlowDiagramBlock,
): (GuidedTourStop & { nodeKey: string })[] {
  return block.nodes.flatMap<GuidedTourStop & { nodeKey: string }>((node) => {
    const sources = node.attachments.flatMap((attachment) =>
      attachment.sources.map((source) => ({ label: attachment.label, source })),
    );

    return sources.length
      ? sources.map(({ label, source }, index) => ({
          nodeKey: node.key,
          anchor: {
            id: `${block.id}:${node.key}:${index}`,
            title: node.label,
            peek: source,
          },
          label: node.label,
          detail: label,
          content: { kind: "source" as const, source: source },
        }))
      : [
          {
            nodeKey: node.key,
            anchor: { id: `${block.id}:${node.key}`, title: node.label },
            label: node.label,
            content: {
              kind: "explanation" as const,
              text: node.description ?? "This node has no code attachments.",
            },
          },
        ];
  });
}

export function FlowDiagram({
  node,
}: {
  node: FlowDiagramBlock & { id: string };
  snapshot: Snapshot;
}) {
  const stops = useMemo(() => flowTourStops(node), [node]);

  const tour = useMemo<GuidedTour>(
    () => ({ id: node.id, title: node.title, stops }),
    [node.id, node.title, stops],
  );

  const [selection, setSelection] = useState<{
    anchor: string;
    revealRequest: number;
  } | null>(null);

  const close = useCallback(() => setSelection(null), []);

  const { overlayRef, portalTarget, paneResize } = useDiagramTourShell(
    selection !== null,
    close,
  );

  const selectedKey = stops.find(
    (stop) => stop.anchor.id === selection?.anchor,
  )?.nodeKey;

  const open = (nodeKey?: string) => {
    const anchor = (
      nodeKey ? stops.find((stop) => stop.nodeKey === nodeKey) : stops[0]
    )?.anchor.id;

    if (anchor)
      setSelection((previous) => ({
        anchor,
        revealRequest: (previous?.revealRequest ?? 0) + 1,
      }));
  };

  const figure = (fullscreen: boolean) => (
    <figure className="flow-diagram" aria-label={node.title}>
      <DiagramHeader
        kind="FLOW"
        title={node.title}
        meta={`${node.nodes.length} ${node.nodes.length === 1 ? "node" : "nodes"}`}
        action={
          <button
            className="diagram-tour-button"
            onClick={() => (fullscreen ? close() : open())}
            aria-label={
              fullscreen ? "Close expanded diagram" : "Expand diagram"
            }
          >
            {fullscreen ? "Close" : "Expand"}
          </button>
        }
      />
      {node.description && (
        <p className="flow-diagram-description">{node.description}</p>
      )}
      <div className="flow-diagram-body">
        <div className="flow-diagram-canvas">
          <FlowGraph
            block={node}
            selectedKey={fullscreen ? selectedKey : undefined}
            onSelect={(item) => open(item.key)}
            interactive={fullscreen}
            // Inline, a top-to-bottom flow stacks its layers and wants the
            // room; a left-to-right one reads fine shorter.
            height={
              fullscreen ? "100%" : node.direction === "right" ? 420 : 560
            }
          />
        </div>
      </div>
      <footer>
        <span>Select a node to explore its code</span>
        <span className="flow-diagram-legend">
          <i className="flow-legend-added" />
          Added
          <i className="flow-legend-removed" />
          Removed
          <i className="flow-legend-modified" />
          Modified
        </span>
      </footer>
    </figure>
  );

  return (
    <>
      {figure(false)}
      {selection && portalTarget
        ? createPortal(
            <DiagramTourOverlay
              className="diagram-tour-overlay--flow"
              tour={tour}
              activeAnchor={selection.anchor}
              revealRequest={selection.revealRequest}
              paneWidth={paneResize.width}
              separatorProps={paneResize.separatorProps}
              overlayRef={overlayRef}
              onClose={close}
              onActiveAnchorChange={(anchor, { reveal }) =>
                setSelection((previous) =>
                  previous
                    ? {
                        anchor,
                        revealRequest: previous.revealRequest + Number(reveal),
                      }
                    : previous,
                )
              }
            >
              {figure(true)}
            </DiagramTourOverlay>,
            portalTarget,
          )
        : null}
    </>
  );
}
