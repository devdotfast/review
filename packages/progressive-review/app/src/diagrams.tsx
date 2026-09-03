import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeMouseHandler,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge as ReactFlowEdge,
  type EdgeProps as ReactFlowEdgeProps,
  type Node as ReactFlowNode,
  type NodeProps as ReactFlowNodeProps,
  getStraightPath,
} from "@xyflow/react";
import {
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import {
  sequenceDiagramPropsSchema,
  throwAuthoringIssue,
} from "../../src/authoring";
import type {
  ActorRef,
  AnchorRef,
  SequenceActorInput,
  SequenceDiagramProps,
  SequenceMessageCodeInput,
  SequenceMessageInput,
} from "../../src/authoring";
import {
  type ValidatedCodePeekInput,
  validatedCodePeekInputFromRef,
} from "./CodePeek";
import { useReviewDebugSettings } from "./debug-settings";
import { hasTextSelectionWithin } from "./diagram-text-selection";
import { DiagramTourOverlay, useDiagramTourShell } from "./diagram-tour";
import { useReviewSession } from "./host/review-session";
import { CommentIcon } from "./icons";
import type { GuidedTour } from "./review-components";
import { useReview } from "./review-context";
import { useReviewPanel } from "./review-panel";
import { useTourPersist, useTourRestore } from "./review-view-state";
import { buildGraphTarget, targetKey } from "./target-fingerprint";
import { useRegisterLiveDiagram } from "./thread-target-model";
import { captureUiEvent } from "./ui-telemetry";

import "@xyflow/react/dist/style.css";

type SequenceParticipantNodeData = {
  participant: ActorRef;
  diagram: string;
  height: number;
  messages: SequenceMessage[];
  messageGap: number;
  messageTop: number;
};
type SequenceParticipantFlowNode = ReactFlowNode<
  SequenceParticipantNodeData,
  "sequenceParticipant"
>;

const sequenceNodeTypes = { sequenceParticipant: SequenceParticipantNode };
const sequenceEdgeTypes = { sequenceMessage: SequenceMessageEdge };

export function sequenceMessageColor(isActive: boolean): string {
  return isActive ? "var(--accent)" : "var(--edge-muted)";
}

export type {
  SequenceActorInput,
  SequenceDiagramProps,
  SequenceMessageCodeInput,
  SequenceMessageInput,
};
export type SequenceInput = SequenceDiagramProps;

interface UncheckedSequenceMessageInput {
  from: SequenceActorInput;
  to: SequenceActorInput;
  label: string;
  anchor?: AnchorRef;
  code?: SequenceMessageCodeInput;
}

interface UncheckedSequenceInput {
  label: string;
  messages: UncheckedSequenceMessageInput[];
}

export interface SequenceMessageCodeBlock {
  language?: string;
  text: string;
}

export interface SequenceMessage {
  id: string;
  from: ActorRef;
  to: ActorRef;
  label: string;
  anchor: AnchorRef;
  code?: SequenceMessageCodeBlock;
}

export interface SequenceRef {
  __kind: "review-sequence-ref";
  id: string;
  label: string;
  participants: ActorRef[];
  messages: SequenceMessage[];
}

export function createSequence(input: UncheckedSequenceInput): SequenceRef {
  sequenceDiagramPropsSchema.parse(input);
  const messages = uniqueSequenceMessageAnchors(
    normalizeSequenceMessages(input),
  );
  const id = `sequence-${slugSequenceActorLabel(input.label)}`;
  const participants = participantsForMessages(messages);
  validateSequenceTargetPaths(input.label, participants, messages);
  return Object.freeze({
    __kind: "review-sequence-ref",
    id,
    label: input.label,
    participants,
    messages: messages.map((message, index) =>
      Object.freeze({
        id: `${id}-message-${index + 1}-${message.anchor.id}`,
        from: message.from,
        to: message.to,
        label: message.label,
        anchor: message.anchor,
        code: message.code,
      }),
    ),
  });
}

function uniqueSequenceMessageAnchors(
  messages: readonly SequenceMessage[],
): SequenceMessage[] {
  const reservedIds = new Set(messages.map((message) => message.anchor.id));
  const usedIds = new Set<string>();
  return messages.map((message, index) => {
    if (!usedIds.has(message.anchor.id)) {
      usedIds.add(message.anchor.id);
      return message;
    }
    const prefix = `${message.anchor.id}--sequence-use-${index + 1}`;
    let id = prefix;
    let suffix = 2;
    while (reservedIds.has(id) || usedIds.has(id)) {
      id = `${prefix}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);
    return {
      ...message,
      anchor: Object.freeze({ ...message.anchor, id }),
    };
  });
}

function validateSequenceTargetPaths(
  diagram: string,
  participants: readonly ActorRef[],
  messages: readonly SequenceMessage[],
): void {
  const participantLabels = new Set<string>();
  for (const participant of participants) {
    if (participantLabels.has(participant.label)) {
      throwAuthoringIssue(
        ["messages"],
        `SequenceDiagram "${diagram}" has more than one participant labelled "${participant.label}"`,
      );
    }
    participantLabels.add(participant.label);
  }
  const parallelLabels = new Map<string, Set<string>>();
  for (const [index, message] of messages.entries()) {
    const segment = `${message.from.label}→${message.to.label}`;
    const labels = parallelLabels.get(segment) ?? new Set<string>();
    if (labels.has(message.label)) {
      throwAuthoringIssue(
        ["messages", index, "label"],
        `Label must be unique among parallel ${segment} messages`,
      );
    }
    labels.add(message.label);
    parallelLabels.set(segment, labels);
  }
}

function normalizeSequenceMessages(
  input: UncheckedSequenceInput,
): SequenceMessage[] {
  const { messages } = input;
  const explicitActorIds = new Set<string>();
  for (const message of messages) {
    if (message.from.id) explicitActorIds.add(message.from.id);
    if (message.to.id) explicitActorIds.add(message.to.id);
  }

  const inlineActorIdsByLabel = new Map<string, string>();
  const usedActorIds = new Set(explicitActorIds);

  const normalizeActor = (actor: SequenceActorInput): ActorRef => {
    if (actor.id) {
      return {
        __kind: "db-actor-ref",
        id: actor.id,
        label: actor.label,
        softwareMapPath: actorSoftwareMapPath(actor),
      };
    }

    const existing = inlineActorIdsByLabel.get(actor.label);
    if (existing) {
      return {
        __kind: "db-actor-ref",
        id: existing,
        label: actor.label,
        softwareMapPath: actorSoftwareMapPath(actor),
      };
    }

    const baseId = `inline-${slugSequenceActorLabel(actor.label) || "actor"}`;
    let id = baseId;
    for (let suffix = 2; usedActorIds.has(id); suffix += 1) {
      id = `${baseId}-${suffix}`;
    }
    usedActorIds.add(id);
    inlineActorIdsByLabel.set(actor.label, id);
    return {
      __kind: "db-actor-ref",
      id,
      label: actor.label,
      softwareMapPath: actorSoftwareMapPath(actor),
    };
  };

  return messages.map((message, index) => {
    const code = normalizeSequenceMessageCode(message.code);
    const fallbackAnchor = {
      __kind: "db-anchor-ref",
      id: `sequence-${slugSequenceActorLabel(input.label) || "diagram"}-message-${index + 1}`,
      title: message.label,
    } satisfies AnchorRef;
    return Object.freeze({
      id: `sequence-message-input-${index + 1}`,
      from: normalizeActor(message.from),
      to: normalizeActor(message.to),
      label: message.label,
      anchor: message.anchor ?? fallbackAnchor,
      code,
    });
  });
}

function actorSoftwareMapPath(actor: SequenceActorInput): string | undefined {
  return "__kind" in actor ? actor.softwareMapPath : undefined;
}

function normalizeSequenceMessageCode(
  code: SequenceMessageCodeInput | undefined,
): SequenceMessageCodeBlock | undefined {
  if (typeof code === "string") {
    const text = code.trim();
    return text ? { text } : undefined;
  }
  if (!code) return undefined;
  const text = code.text.trim();
  if (!text) return undefined;
  const language = code.language?.trim();
  return language ? { language, text } : { text };
}

function slugSequenceActorLabel(label: string) {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function createSequenceTourEntry(sequence: SequenceRef): GuidedTour {
  const participantById = new Map(
    sequence.participants.map((participant) => [participant.id, participant]),
  );
  return {
    id: sequence.id,
    title: sequence.label,
    telemetryKind: "sequence" as const,
    stops: sequence.messages.map((message) => ({
      anchor: message.anchor,
      label: message.label,
      detail:
        participantById.get(message.from.id)?.label &&
        participantById.get(message.to.id)?.label
          ? `${participantById.get(message.from.id)?.label} -> ${
              participantById.get(message.to.id)?.label
            }`
          : undefined,
      content: message.code
        ? {
            kind: "inline-code" as const,
            ...message.code,
          }
        : {
            kind: "resolved-code" as const,
            input: validatedCodePeekInputFromRef(message.anchor.peek!),
          },
    })),
  };
}

function participantsForMessages(messages: SequenceMessage[]): ActorRef[] {
  const participants = new Map<string, { actor: ActorRef; order: number }>();
  const outgoing = new Map<string, Set<string>>();
  const incomingCount = new Map<string, number>();
  for (const message of messages) {
    if (!participants.has(message.from.id)) {
      participants.set(message.from.id, {
        actor: message.from,
        order: participants.size,
      });
      incomingCount.set(message.from.id, 0);
    }
    if (!participants.has(message.to.id)) {
      participants.set(message.to.id, {
        actor: message.to,
        order: participants.size,
      });
      incomingCount.set(message.to.id, 0);
    }
    if (message.from.id === message.to.id) continue;
    const targets = outgoing.get(message.from.id) ?? new Set<string>();
    if (!targets.has(message.to.id)) {
      targets.add(message.to.id);
      outgoing.set(message.from.id, targets);
      incomingCount.set(
        message.to.id,
        (incomingCount.get(message.to.id) ?? 0) + 1,
      );
    }
  }
  const byFirstSeen = (left: string, right: string) =>
    (participants.get(left)?.order ?? 0) -
    (participants.get(right)?.order ?? 0);
  const ready = [...participants.keys()]
    .filter((id) => (incomingCount.get(id) ?? 0) === 0)
    .sort(byFirstSeen);
  const ordered: ActorRef[] = [];
  const consumed = new Set<string>();

  while (ready.length > 0) {
    const id = ready.shift()!;
    if (consumed.has(id)) continue;
    consumed.add(id);
    const actor = participants.get(id)?.actor;
    if (actor) ordered.push(actor);
    for (const target of outgoing.get(id) ?? []) {
      incomingCount.set(target, (incomingCount.get(target) ?? 0) - 1);
      if ((incomingCount.get(target) ?? 0) === 0) {
        ready.push(target);
        ready.sort(byFirstSeen);
      }
    }
  }

  for (const [id, participant] of [...participants.entries()].sort(
    (left, right) => left[1].order - right[1].order,
  )) {
    if (!consumed.has(id)) ordered.push(participant.actor);
  }
  return ordered;
}

export function SequenceDiagram(input: SequenceInput) {
  const session = useReviewSession();
  const { theme } = useReviewDebugSettings();
  const sequence = useMemo(
    () => createSequence(input),
    [input.label, input.messages],
  );
  useRegisterLiveDiagram({
    label: sequence.label,
    elements: sequenceTargetElements(sequence),
  });
  const tour = useMemo(() => createSequenceTourEntry(sequence), [sequence]);
  // The tour IS the fullscreen mode: the inline figure becomes the stage
  // and the standard GuidedTourPanel docks beside it.
  const [tourState, setTourState] = useState<{
    anchor: string;
    revealRequest: number;
  } | null>(null);
  const tourAnchor = tourState?.anchor ?? null;
  const tourOpen = tourState !== null;
  const restoredTour = useTourRestore(tour);
  useTourPersist(tourOpen ? tour : null, tourAnchor);

  useEffect(() => {
    if (!restoredTour) return;
    setTourState({ anchor: restoredTour.activeAnchor, revealRequest: 0 });
  }, [restoredTour]);

  const openTour = useCallback(
    (anchor?: string) => {
      if (anchor) {
        captureUiEvent(session, "peek_opened", { via: "diagram" });
      }
      const nextAnchor = anchor ?? tourAnchor ?? tour.stops[0]?.anchor.id;
      if (!nextAnchor) return;
      if (!tourOpen) {
        captureUiEvent(session, "tour_started", { steps: tour.stops.length });
      }
      setTourState((state) => ({
        anchor: nextAnchor,
        revealRequest: (state?.revealRequest ?? 0) + 1,
      }));
    },
    [session, tour, tourAnchor, tourOpen],
  );
  const closeTour = useCallback(() => setTourState(null), []);
  const changeTourAnchor = useCallback(
    (anchor: string, options: { reveal: boolean }) => {
      setTourState((state) =>
        state
          ? {
              anchor,
              revealRequest: options.reveal
                ? state.revealRequest + 1
                : state.revealRequest,
            }
          : state,
      );
    },
    [],
  );

  const {
    overlayRef,
    portalTarget,
    paneResize: tourPaneResize,
  } = useDiagramTourShell(tourOpen, closeTour);

  return (
    <>
      <SequenceDiagramFigure
        sequence={sequence}
        theme={theme}
        stopCount={tour.stops.length}
        openTour={openTour}
        activeTourAnchor={null}
      />
      {tourOpen && portalTarget
        ? createPortal(
            <DiagramTourOverlay
              tour={tour}
              activeAnchor={tourAnchor!}
              revealRequest={tourState?.revealRequest ?? 0}
              paneWidth={tourPaneResize.width}
              separatorProps={tourPaneResize.separatorProps}
              overlayRef={overlayRef}
              onActiveAnchorChange={changeTourAnchor}
              onClose={closeTour}
            >
              <SequenceDiagramFigure
                sequence={sequence}
                theme={theme}
                stopCount={tour.stops.length}
                openTour={openTour}
                activeTourAnchor={tourAnchor}
                onCloseTour={closeTour}
              />
            </DiagramTourOverlay>,
            portalTarget,
          )
        : null}
    </>
  );
}

function SequenceDiagramFigure({
  sequence,
  theme,
  stopCount,
  openTour,
  activeTourAnchor,
  onCloseTour,
}: {
  sequence: ReturnType<typeof createSequence>;
  theme: ReturnType<typeof useReviewDebugSettings>["theme"];
  stopCount: number;
  openTour: (anchor?: string) => void;
  activeTourAnchor: string | null;
  /** Present when the figure is the fullscreen tour stage: the header swaps
   * its Tour button for a close control and message dots show stop numbers. */
  onCloseTour?: () => void;
}) {
  const sequenceScrollRef = useRef<HTMLDivElement | null>(null);
  const panelMotion = useReviewPanel((state) => state.motion);
  const [availableWidth, setAvailableWidth] = useState(0);
  useEffect(() => {
    const scroll = sequenceScrollRef.current;
    if (!scroll) return;
    const update = () => setAvailableWidth(scroll.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, []);
  // Lanes spread across the full diagram width; 176px is the floor below which
  // the body scrolls horizontally instead of compressing further.
  const laneWidth = Math.max(
    176,
    Math.floor(availableWidth / Math.max(1, sequence.participants.length)),
  );
  const messageTop = 112;
  const messageGap = 76;
  const width = Math.max(320, sequence.participants.length * laneWidth);
  const height = messageTop + sequence.messages.length * messageGap + 42;
  const reactFlowNodes: SequenceParticipantFlowNode[] = useMemo(
    () =>
      sequence.participants.map((participant, index) => ({
        id: participant.id,
        type: "sequenceParticipant",
        position: { x: index * laneWidth, y: 0 },
        width: laneWidth,
        height,
        data: {
          participant,
          diagram: sequence.label,
          height,
          messages: sequence.messages,
          messageGap,
          messageTop,
        },
        draggable: false,
        selectable: false,
      })),
    [height, laneWidth, sequence],
  );
  const reactFlowEdges: ReactFlowEdge[] = useMemo(
    () =>
      sequence.messages.map((message, index) => {
        const isActive = activeTourAnchor === message.anchor.id;
        const color = sequenceMessageColor(isActive);
        return {
          id: message.id,
          type: "sequenceMessage",
          source: message.from.id,
          target: message.to.id,
          sourceHandle: sequenceHandleId(message.id, "source"),
          targetHandle: sequenceHandleId(message.id, "target"),
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color,
          },
          style: { stroke: color },
          data: {
            message,
            index,
            width,
            active: isActive,
            diagram: sequence.label,
            path: sequenceEdgePath(sequence.messages, message),
            openTour,
            stepNumber: onCloseTour ? index + 1 : null,
          },
          className: isActive
            ? "sequence-message clickable active"
            : "sequence-message clickable",
          zIndex: isActive ? 2 : 1,
        };
      }),
    [activeTourAnchor, onCloseTour, openTour, sequence, width],
  );
  const onEdgeClick: EdgeMouseHandler = (event, edge) => {
    event.stopPropagation();
    const data = edge.data as { message?: SequenceMessage } | undefined;
    if (data?.message) openTour(data.message.anchor.id);
  };
  const scrollSequenceHorizontally = useCallback((event: WheelEvent) => {
    const scroll = event.currentTarget;
    if (
      !(scroll instanceof HTMLElement) ||
      !scrollDiagramHorizontally(scroll, event)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }, []);
  useEffect(() => {
    const scroll = sequenceScrollRef.current;
    if (!scroll) return;
    scroll.addEventListener("wheel", scrollSequenceHorizontally, {
      capture: true,
      passive: false,
    });
    return () =>
      scroll.removeEventListener("wheel", scrollSequenceHorizontally, {
        capture: true,
      });
  }, [scrollSequenceHorizontally]);
  useEffect(() => {
    const scroll = sequenceScrollRef.current;
    if (!scroll || !activeTourAnchor) return;
    const nextScrollLeft = sequenceActiveMessageScrollTarget({
      sequence,
      activeAnchor: activeTourAnchor,
      laneWidth,
      viewportWidth: scroll.clientWidth,
      scrollWidth: scroll.scrollWidth,
      currentScrollLeft: scroll.scrollLeft,
    });
    const nextScrollTop = sequenceActiveMessageScrollTopTarget({
      sequence,
      activeAnchor: activeTourAnchor,
      messageTop,
      messageGap,
      viewportHeight: scroll.clientHeight,
      scrollHeight: scroll.scrollHeight,
      currentScrollTop: scroll.scrollTop,
    });
    const left =
      nextScrollLeft !== null &&
      Math.abs(nextScrollLeft - scroll.scrollLeft) >= 1
        ? nextScrollLeft
        : undefined;
    const top =
      nextScrollTop !== null && Math.abs(nextScrollTop - scroll.scrollTop) >= 1
        ? nextScrollTop
        : undefined;
    if (left === undefined && top === undefined) return;
    scroll.scrollTo({
      left,
      top,
      behavior: panelMotion === "restored" ? "auto" : "smooth",
    });
  }, [activeTourAnchor, laneWidth, panelMotion, sequence]);
  const style = {
    "--sequence-width": `${width}px`,
    "--sequence-height": `${height}px`,
    "--sequence-lane-width": `${laneWidth}px`,
  } as CSSProperties;

  return (
    <>
      <figure
        className={sequenceDiagramClassName(Boolean(activeTourAnchor))}
        style={style}
        tabIndex={-1}
        data-sequence-tour-id={sequence.id}
      >
        <DiagramHeader
          kind="SEQ"
          title={sequence.label}
          meta={`${stopCount} stops`}
          action={
            // The tour panel's header owns the close control fullscreen.
            onCloseTour ? null : (
              <button
                type="button"
                className="diagram-tour-button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openTour();
                }}
              >
                Tour
              </button>
            )
          }
        />
        <div
          ref={sequenceScrollRef}
          className="sequence-diagram-body"
          onClick={() => openTour()}
        >
          <ReactFlow
            colorMode={theme}
            nodes={reactFlowNodes}
            edges={reactFlowEdges}
            nodeTypes={sequenceNodeTypes}
            edgeTypes={sequenceEdgeTypes}
            onEdgeClick={onEdgeClick}
            defaultViewport={{ x: 0, y: 0, zoom: 1 }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panActivationKeyCode={null}
            panOnDrag={false}
            preventScrolling={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            proOptions={{ hideAttribution: true }}
          />
        </div>
      </figure>
    </>
  );
}

export function sequenceTargetElements(
  sequence: SequenceRef,
): Extract<ReturnType<typeof buildGraphTarget>, { kind: "graph" }>[] {
  return [
    ...sequence.participants.map((participant) =>
      buildGraphTarget({
        diagram: sequence.label,
        type: "node",
        path: [participant.label],
        payload: participant,
        quote: participant.label,
      }),
    ),
    ...sequence.messages.map((message) =>
      buildGraphTarget({
        diagram: sequence.label,
        type: "edge",
        path: sequenceEdgePath(sequence.messages, message),
        payload: {
          from: message.from.label,
          to: message.to.label,
          label: message.label,
          code: message.code,
        },
        quote: message.label,
      }),
    ),
  ];
}

export function sequencePeekInputs(
  sequence: SequenceRef,
): Map<string, ValidatedCodePeekInput> {
  const validatedPeeks = new Map<string, ValidatedCodePeekInput>();
  for (const message of sequence.messages) {
    if (message.anchor.peek) {
      validatedPeeks.set(
        message.anchor.id,
        validatedCodePeekInputFromRef(message.anchor.peek),
      );
    }
  }
  return validatedPeeks;
}

export function sequenceDiagramClassName(isTourActive: boolean): string {
  return isTourActive
    ? "sequence-diagram sequence-tour sequence-tour--active"
    : "sequence-diagram sequence-tour";
}

function DiagramHeader({
  kind,
  title,
  meta,
  action,
}: {
  kind: string;
  title: string;
  meta?: string;
  action?: ReactNode;
}) {
  return (
    <figcaption className="diagram-header">
      <div className="diagram-header-main">
        <span className="diagram-kind-badge">{kind}</span>
        <span className="diagram-header-title">{title}</span>
        {meta && <em className="diagram-header-meta">{meta}</em>}
      </div>
      {action}
    </figcaption>
  );
}

function SequenceParticipantNode({
  data,
}: ReactFlowNodeProps<SequenceParticipantFlowNode>) {
  const review = useReview();
  const { participant, diagram, height, messages, messageGap, messageTop } =
    data;
  const target = buildGraphTarget({
    diagram,
    type: "node",
    path: [participant.label],
    payload: participant,
    quote: participant.label,
  });
  const activeMessages = messages.filter(
    (message) =>
      message.from.id === participant.id || message.to.id === participant.id,
  );
  const openParticipantComment = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    review.openCommentDraft({
      target,
      title: participant.label,
      body: "",
    });
  };
  return (
    <div
      className="sequence-participant-node"
      style={{ height }}
      data-review-locator={targetKey(target)}
      onContextMenu={openParticipantComment}
    >
      <div className="sequence-participant-comment-target">
        <span
          className="sequence-participant-label"
          title={participant.label}
          onClick={(event) => {
            event.stopPropagation();
          }}
          onContextMenu={openParticipantComment}
        >
          {participant.label}
        </span>
        <HoverCommentButton onClick={openParticipantComment} />
      </div>
      <div className="sequence-lifeline" />
      {activeMessages.flatMap((message, index) => {
        const messageIndex = messages.findIndex(
          (item) => item.id === message.id,
        );
        const top = messageTop + messageIndex * messageGap;
        const isSelfLoop = message.from.id === message.to.id;
        const handles: Array<{
          id: string;
          type: "source" | "target";
          side: Position.Left | Position.Right;
        }> = [];
        if (message.from.id === participant.id) {
          handles.push({
            id: sequenceHandleId(message.id, "source"),
            type: "source",
            side: isSelfLoop ? Position.Right : Position.Right,
          });
        }
        if (message.to.id === participant.id) {
          handles.push({
            id: sequenceHandleId(message.id, "target"),
            type: "target",
            side: isSelfLoop ? Position.Right : Position.Left,
          });
        }
        return handles.map((handle) => (
          <Handle
            key={`${message.id}-${handle.type}-${index}`}
            id={handle.id}
            type={handle.type}
            position={handle.side}
            className="sequence-message-handle"
            style={{
              left: "50%",
              top: sequenceMessageHandleTop(message, handle.type, top),
            }}
          />
        ));
      })}
    </div>
  );
}

export function sequenceMessageHandleTop(
  message: { from: { id: string }; to: { id: string } },
  handleType: "source" | "target",
  messageTop: number,
): number {
  return message.from.id === message.to.id && handleType === "target"
    ? messageTop + 24
    : messageTop;
}

export function sequenceSelfMessagePath(input: {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  width: number;
}): string {
  const loopDirection = input.sourceX + 72 > input.width ? -1 : 1;
  const loopX = input.sourceX + loopDirection * 54;
  return `M ${input.sourceX} ${input.sourceY} H ${loopX} V ${input.targetY} H ${input.targetX}`;
}

function SequenceMessageEdge(props: ReactFlowEdgeProps) {
  const review = useReview();
  const [isHoveringEdge, setIsHoveringEdge] = useState(false);
  const data = props.data as {
    message: SequenceMessage;
    index: number;
    width: number;
    active: boolean;
    diagram: string;
    path: string[];
    openTour: (anchor?: string) => void;
    stepNumber: number | null;
  };
  const isSelfLoop = props.source === props.target;
  const loopDirection = props.sourceX + 72 > data.width ? -1 : 1;
  const loopX = props.sourceX + loopDirection * 54;
  const edgePath = isSelfLoop
    ? sequenceSelfMessagePath({
        sourceX: props.sourceX,
        sourceY: props.sourceY,
        targetX: props.targetX,
        targetY: props.targetY,
        width: data.width,
      })
    : getStraightPath({
        sourceX: props.sourceX,
        sourceY: props.sourceY,
        targetX: props.targetX,
        targetY: props.targetY,
      })[0];
  const labelX = isSelfLoop
    ? (props.sourceX + loopX) / 2
    : (props.sourceX + props.targetX) / 2;
  const labelY = props.sourceY - 12;
  const edgeClassName = data.active
    ? "sequence-message clickable active"
    : "sequence-message clickable";
  const target = buildGraphTarget({
    diagram: data.diagram,
    type: "edge",
    path: data.path,
    payload: {
      from: data.message.from.label,
      to: data.message.to.label,
      label: data.message.label,
      code: data.message.code,
    },
    quote: data.message.label,
  });
  const openMessageComment = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    review.openCommentDraft({
      target,
      title: data.message.label,
      body: "",
    });
  };
  return (
    <>
      <BaseEdge
        id={props.id}
        path={edgePath}
        markerEnd={props.markerEnd}
        className={edgeClassName}
        style={props.style}
      />
      <path
        d={edgePath}
        className="sequence-message-hit-area"
        onMouseEnter={() => setIsHoveringEdge(true)}
        onMouseLeave={() => setIsHoveringEdge(false)}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          data.openTour(data.message.anchor.id);
        }}
      />
      <EdgeLabelRenderer>
        <button
          type="button"
          className={[
            "sequence-message-dot",
            data.active ? "active" : null,
            data.stepNumber !== null ? "sequence-message-dot--step" : null,
          ]
            .filter(Boolean)
            .join(" ")}
          style={{
            transform: `translate(-50%, -50%) translate(${props.sourceX}px,${props.sourceY}px)`,
          }}
          data-review-anchor-id={data.message.anchor.id}
          data-review-locator={targetKey(target)}
          onContextMenu={openMessageComment}
          onClick={(event) => {
            event.stopPropagation();
            data.openTour(data.message.anchor.id);
          }}
          aria-label={data.message.label}
        >
          {data.stepNumber}
        </button>
        <div
          className={
            isHoveringEdge
              ? "sequence-message-comment-target comment-target-hovered"
              : "sequence-message-comment-target"
          }
          style={{
            transform: `translate(-50%, -100%) translate(${labelX}px,${labelY}px)`,
          }}
        >
          <span
            role="button"
            tabIndex={0}
            className={
              data.active
                ? "sequence-message-label clickable active"
                : "sequence-message-label clickable"
            }
            data-review-anchor-id={data.message.anchor.id}
            data-review-locator={targetKey(target)}
            onMouseEnter={() => setIsHoveringEdge(true)}
            onMouseLeave={() => setIsHoveringEdge(false)}
            onClick={(event) => {
              event.stopPropagation();
              if (hasTextSelectionWithin(event.currentTarget)) return;
              data.openTour(data.message.anchor.id);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.stopPropagation();
              data.openTour(data.message.anchor.id);
            }}
          >
            {data.message.label}
          </span>
          <HoverCommentButton onClick={openMessageComment} />
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

function HoverCommentButton({
  onClick,
  className = "",
  style,
}: {
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      className={["comment-hover-button", className].filter(Boolean).join(" ")}
      style={style}
      onClick={onClick}
      aria-label="Comment"
      title="Comment"
    >
      <CommentIcon />
    </button>
  );
}

interface HorizontalScrollEvent {
  deltaX: number;
  deltaY: number;
  shiftKey: boolean;
}

interface SequenceActiveMessageScrollInput {
  sequence: SequenceRef;
  activeAnchor: string | null;
  laneWidth: number;
  viewportWidth: number;
  scrollWidth: number;
  currentScrollLeft: number;
  padding?: number;
}

function scrollDiagramHorizontally(
  scroll: HTMLElement,
  event: HorizontalScrollEvent,
) {
  const delta =
    event.deltaX !== 0 ? event.deltaX : event.shiftKey ? event.deltaY : 0;
  if (delta === 0 || scroll.scrollWidth <= scroll.clientWidth) return false;
  const nextLeft = Math.min(
    Math.max(scroll.scrollLeft + delta, 0),
    scroll.scrollWidth - scroll.clientWidth,
  );
  if (nextLeft === scroll.scrollLeft) return false;
  scroll.scrollLeft = nextLeft;
  return true;
}

export function sequenceActiveMessageScrollTarget({
  sequence,
  activeAnchor,
  laneWidth,
  viewportWidth,
  scrollWidth,
  currentScrollLeft,
  padding = 24,
}: SequenceActiveMessageScrollInput) {
  const maxScrollLeft = scrollWidth - viewportWidth;
  if (!activeAnchor || maxScrollLeft <= 0 || viewportWidth <= 0) return null;
  const activeMessage = sequence.messages.find(
    (message) => message.anchor.id === activeAnchor,
  );
  if (!activeMessage) return null;
  const fromIndex = sequence.participants.findIndex(
    (participant) => participant.id === activeMessage.from.id,
  );
  const toIndex = sequence.participants.findIndex(
    (participant) => participant.id === activeMessage.to.id,
  );
  if (fromIndex < 0 || toIndex < 0) return null;

  const leftLane = Math.min(fromIndex, toIndex);
  const rightLane = Math.max(fromIndex, toIndex);
  const targetLeft = Math.max(0, leftLane * laneWidth - padding);
  const targetRight = Math.min(
    scrollWidth,
    (rightLane + 1) * laneWidth + padding,
  );
  const visibleLeft = currentScrollLeft;
  const visibleRight = currentScrollLeft + viewportWidth;
  const clampScrollLeft = (left: number) =>
    Math.min(Math.max(left, 0), maxScrollLeft);

  if (targetLeft >= visibleLeft && targetRight <= visibleRight) {
    return currentScrollLeft;
  }
  if (targetRight - targetLeft > viewportWidth) {
    return clampScrollLeft(targetLeft);
  }
  if (targetLeft < visibleLeft) {
    return clampScrollLeft(targetLeft);
  }
  return clampScrollLeft(targetRight - viewportWidth);
}

interface SequenceActiveMessageScrollTopInput {
  sequence: SequenceRef;
  activeAnchor: string | null;
  messageTop: number;
  messageGap: number;
  viewportHeight: number;
  scrollHeight: number;
  currentScrollTop: number;
  padding?: number;
}

// Vertical counterpart of sequenceActiveMessageScrollTarget: long diagrams
// scroll inside a viewport-capped body, so stepping the tour must also bring
// the active message's row into view. Row y derives from the same layout
// constants that position the message edges.
export function sequenceActiveMessageScrollTopTarget({
  sequence,
  activeAnchor,
  messageTop,
  messageGap,
  viewportHeight,
  scrollHeight,
  currentScrollTop,
  padding = 24,
}: SequenceActiveMessageScrollTopInput) {
  const maxScrollTop = scrollHeight - viewportHeight;
  if (!activeAnchor || maxScrollTop <= 0 || viewportHeight <= 0) return null;
  const messageIndex = sequence.messages.findIndex(
    (message) => message.anchor.id === activeAnchor,
  );
  if (messageIndex < 0) return null;

  const rowTop = messageTop + messageIndex * messageGap;
  const targetTop = Math.max(0, rowTop - padding);
  const targetBottom = Math.min(scrollHeight, rowTop + messageGap + padding);
  const visibleTop = currentScrollTop;
  const visibleBottom = currentScrollTop + viewportHeight;
  const clampScrollTop = (top: number) =>
    Math.min(Math.max(top, 0), maxScrollTop);

  if (targetTop >= visibleTop && targetBottom <= visibleBottom) {
    return currentScrollTop;
  }
  if (targetBottom - targetTop > viewportHeight) {
    return clampScrollTop(targetTop);
  }
  if (targetTop < visibleTop) {
    return clampScrollTop(targetTop);
  }
  return clampScrollTop(targetBottom - viewportHeight);
}

function sequenceHandleId(
  messageId: string,
  handleType: "source" | "target",
): string {
  return `${handleType}-${messageId}`;
}

function sequenceEdgePath(
  messages: readonly SequenceMessage[],
  message: SequenceMessage,
): string[] {
  const segment = `${message.from.label}→${message.to.label}`;
  const parallelCount = messages.filter(
    (candidate) =>
      candidate.from.id === message.from.id &&
      candidate.to.id === message.to.id,
  ).length;
  return parallelCount > 1 ? [segment, message.label] : [segment];
}
