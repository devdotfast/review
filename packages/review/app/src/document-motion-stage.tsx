import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { BlockChange } from "./document-motion";

/**
 * How one document block moves when a version arrives from the agent. The
 * timings and shapes are the whiteboard motion sketches: the eraser makes
 * three passes and the old text drops to ghost ink; a new block gets a slot
 * first, then wipes in behind the marker dot; a removed block is erased and
 * then collapses away; a slot the agent has promised but not filled shows
 * the plotter drawing loops. Phases advance on timers,
 * heights are measured here so the document makes room exactly once, and
 * whiteboard.css draws each phase from the `data-motion` attribute.
 */
type Phase =
  | "idle"
  | "waiting"
  | "closing"
  | "closed"
  | "opening"
  | "filling"
  | "landed"
  | "erasing"
  | "rewriting"
  | "removed"
  | "erased";

const SLOT_HEIGHT = 128;

const TIMELINES: Partial<Record<Phase, [number, Phase][]>> = {
  opening: [
    [260, "filling"],
    [680, "landed"],
    [930, "idle"],
  ],
  filling: [
    [420, "landed"],
    [670, "idle"],
  ],
  closing: [[260, "closed"]],
};

const ERASE_TIMELINES = {
  block: [
    [1000, "rewriting"],
    [2000, "idle"],
  ],
  ghost: [
    [1000, "removed"],
    [1400, "erased"],
  ],
} satisfies Record<string, [number, Phase][]>;

interface StageState {
  signature: string;
  generation: number;
  start: Phase;
  phase: Phase;
  fromSlot: boolean;
}

function startPhase(
  kind: "block" | "ghost" | "slot",
  change: BlockChange | undefined,
  open: boolean,
  before: Phase | undefined,
): Phase {
  const wasSlot = before === "waiting" || before === "closing";

  switch (kind) {
    case "slot":
      if (open) return "waiting";

      return wasSlot ? "closing" : "closed";
    case "ghost":
      return "erasing";
    case "block":
      if (change === "new") return wasSlot ? "filling" : "opening";

      return change === "replaced" ? "erasing" : "idle";
  }
}

/** The height the block wants, read without disturbing the height it has:
 * the reflow after restoring keeps the transition starting from the latter. */
const naturalHeight = (node: HTMLElement) => {
  const explicit = node.style.height;
  node.style.height = "auto";
  const height = node.getBoundingClientRect().height;
  node.style.height = explicit;
  void node.offsetHeight;

  return height;
};

const snapHeight = (node: HTMLElement, px: number) => {
  node.style.transition = "none";
  node.style.height = `${px}px`;
  void node.offsetHeight;
  node.style.transition = "";
};

export function BlockStage({
  version,
  kind,
  change,
  open = false,
  id,
  copyProse,
  before,
  old,
  children,
}: {
  version: number;
  kind: "block" | "ghost" | "slot";
  change?: BlockChange;
  /** For a slot: whether the agent is still expected to fill it. */
  open?: boolean;
  id?: string;
  copyProse?: boolean;
  /** Rendered above the block, outside the animated layers. */
  before?: ReactNode;
  /** The block's content before this version, erased on the way out. */
  old?: ReactNode;
  children?: ReactNode;
}) {
  const signature = `${version}|${kind}|${change ?? ""}|${open}`;

  const [state, setState] = useState<StageState>(() => {
    const phase = startPhase(kind, change, open, undefined);

    return { signature, generation: 0, start: phase, phase, fromSlot: false };
  });

  let current = state;

  // A new version (or a slot no longer awaited) starts a new timeline; the
  // decision is made during render so the old layer keeps its DOM.
  if (state.signature !== signature) {
    const phase = startPhase(kind, change, open, state.phase);

    current = {
      signature,
      generation:
        state.generation + (kind === "block" && change === "replaced" ? 1 : 0),
      start: phase,
      phase,
      fromSlot: state.phase === "waiting" || state.phase === "closing",
    };
    setState(current);
  }

  const node = useRef<HTMLDivElement>(null);
  const oldLayer = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const steps =
      current.start === "erasing"
        ? ERASE_TIMELINES[kind === "ghost" ? "ghost" : "block"]
        : (TIMELINES[current.start] ?? []);

    const timers = steps.map(([ms, phase]) =>
      setTimeout(() => setState((state) => ({ ...state, phase })), ms),
    );

    return () => timers.forEach(clearTimeout);
  }, [current.signature]);

  const { phase } = current;

  useLayoutEffect(() => {
    const element = node.current;

    if (!element) return;

    switch (phase) {
      case "waiting":
        if (element.style.height === "") snapHeight(element, 0);
        element.style.height = `${SLOT_HEIGHT}px`;
        break;
      case "closing":
        element.style.height = "0px";
        break;
      case "opening": {
        const height = naturalHeight(element);

        // Nothing to make room for (a collapsed section): skip the motion.
        if (!height) {
          setState((state) => ({ ...state, phase: "idle" }));
          break;
        }

        snapHeight(element, 0);
        element.style.height = `${height}px`;
        break;
      }

      case "filling":
        element.style.height = `${naturalHeight(element)}px`;
        break;
      case "erasing": {
        element.style.height = `${element.getBoundingClientRect().height}px`;
        const ink = oldLayer.current;
        const overlay = ghost.current;

        if (!ink || !overlay) break;

        overlay.replaceChildren(
          ...[...ink.children].map((child) => child.cloneNode(true)),
        );

        for (const cloned of overlay.querySelectorAll("[id]"))
          cloned.removeAttribute("id");

        // The overlay is a formatting root, so the copy's first margin no
        // longer collapses through it; line the ghost up with the ink.
        const inkTop = ink.firstElementChild?.getBoundingClientRect().top;
        const ghostTop = overlay.firstElementChild?.getBoundingClientRect().top;

        if (inkTop !== undefined && ghostTop !== undefined)
          overlay.style.top = `${inkTop - ghostTop}px`;
        break;
      }

      case "rewriting":
        element.style.height = `${naturalHeight(element)}px`;
        break;
      case "removed":
        element.style.height = "0px";
        break;
      case "idle":
        element.style.height = "";
        break;
      case "closed":
      case "erased":
      case "landed":
        break;
    }
  }, [phase]);

  const showOld = phase === "erasing";

  const showGhost =
    phase === "erasing" || phase === "rewriting" || phase === "removed";

  const showPlotter =
    (kind === "slot" && phase !== "closed") ||
    (phase === "filling" && current.fromSlot);

  const oldGeneration =
    kind === "block" && change === "replaced"
      ? current.generation - 1
      : current.generation;

  // A removed block, once erased, leaves nothing behind.
  if (phase === "erased") return null;

  return (
    <div
      ref={node}
      className="api-document-node"
      data-motion={phase === "idle" ? undefined : phase}
      data-review-node-id={id}
      data-review-copy-prose={copyProse || undefined}
    >
      {before}
      {showOld && (
        <div
          key={`layer:${oldGeneration}`}
          ref={oldLayer}
          className="review-motion-layer review-motion-layer--old"
          inert
        >
          {old}
        </div>
      )}
      {showGhost && (
        <div
          ref={ghost}
          className="review-motion-layer review-motion-ghost"
          aria-hidden="true"
          inert
        />
      )}
      {kind === "block" && (
        <div
          key={`layer:${current.generation}`}
          className="review-motion-layer review-motion-layer--new"
        >
          {children}
        </div>
      )}
      {phase === "erasing" && (
        <div className="review-motion-eraser" aria-hidden="true" />
      )}
      {phase === "filling" && (
        <div className="review-motion-dot" aria-hidden="true" />
      )}
      {showPlotter && <DocumentPlotter />}
    </div>
  );
}

const LOOPS =
  "M38 85c25 0 20-32 40-25s-11 51 9 35 20-57 40-38-35 30-12 41 26-48 49-33-35 26-9 33 28-25 50-17 36 4 69-3";

const VIEW = { width: 320, height: 140 };

const DRAW_MS = 4200;

const HOLD_MS = 700;

const PERIOD_MS = 5600;

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/**
 * The pen plotter drawing the loop study in marker ink while the agent
 * works: the rail drops to the pen's line, the carriage follows its x, the
 * tip leaves the stroke. Drawn over 4.2s, held, faded, looped.
 */
function DocumentPlotter() {
  const root = useRef<HTMLDivElement>(null);
  const path = useRef<SVGPathElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const carriage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = root.current;
    const stroke = path.current;
    const gantry = rail.current;
    const pen = carriage.current;

    if (!container || !stroke || !gantry || !pen) return;

    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let width = 0;
    let height = 0;
    let length = 0;

    const measure = () => {
      width = container.clientWidth;
      height = container.clientHeight;
      length = width && height ? stroke.getTotalLength() : 0;
      stroke.style.strokeDasharray = `${length}`;
    };

    const observer = new ResizeObserver(measure);
    observer.observe(container);
    measure();
    const started = performance.now();
    let frame = 0;

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);

      if (!length) return;
      const elapsed = (now - started) % PERIOD_MS;
      let k = 1;
      let alpha = 1;

      if (elapsed < DRAW_MS) k = ease(elapsed / DRAW_MS);
      else if (elapsed >= DRAW_MS + HOLD_MS)
        alpha =
          1 - (elapsed - DRAW_MS - HOLD_MS) / (PERIOD_MS - DRAW_MS - HOLD_MS);

      stroke.style.strokeDashoffset = `${length * (1 - k)}`;
      stroke.style.opacity = `${alpha * (0.35 + 0.65 * Math.min(1, k * 4))}`;

      const point = stroke.getPointAtLength(length * k);
      const scale = Math.min(width / VIEW.width, height / VIEW.height);
      const x = (width - VIEW.width * scale) / 2 + point.x * scale;
      const y = (height - VIEW.height * scale) / 2 + point.y * scale;
      gantry.style.top = `${y - 22}px`;
      gantry.style.opacity = `${alpha}`;
      pen.style.left = `${x - 6}px`;
    };

    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return (
    <div ref={root} className="review-motion-plotter" aria-hidden="true">
      <svg viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}>
        <path opacity=".15" d="M37 88h246" />
        <path ref={path} className="review-motion-loops" d={LOOPS} />
      </svg>
      <div ref={rail} className="review-motion-rail">
        <div ref={carriage} className="review-motion-carriage">
          <div className="review-motion-pen" />
        </div>
      </div>
    </div>
  );
}
