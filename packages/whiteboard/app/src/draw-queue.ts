import type { EditSummary } from "../../src/session-api/document";
import type { AuthoringCursor } from "./authoring-cursor";

/**
 * The draw queue: every cursor move the stream delivers is drawn in order,
 * one at a time, for as long as its drawing takes, and the courier stands on
 * the one being drawn. A focus is held on the board until the next arrival.
 * A diagram written whole is traced in one quick pass, unit by unit in the
 * order a hand would draw it; a burst of units for one diagram larger than
 * WHOLE_THRESHOLD is folded into the same quick pass instead of a strobe of
 * full outlines.
 */
export type MotionPhase =
  | "queued"
  | "landing"
  | "outline"
  | "stroke"
  | "fill"
  | "rewriting"
  | "relabel"
  | "retitle"
  | "erasing"
  | "attention";

export interface DrawStep {
  phase: MotionPhase | null;
  /** Infinity holds the step until the next arrival. */
  ms: number;
  /** The elements this step draws when they are not the cursor's target:
   * the edge a new node arrived with, or the units of one quick stroke. */
  targets?: string[];
}

export interface DrawEntry {
  cursor: AuthoringCursor;
  steps: DrawStep[];
}

export interface DrawHead extends DrawEntry {
  index: number;
  until: number;
}

export interface DrawState {
  pending: DrawEntry[];
  head: DrawHead | null;
  /** Where the courier stands once the queue is empty. */
  standing: AuthoringCursor | null;
}

export const WHOLE_THRESHOLD = 20;

export const EMPTY_QUEUE: DrawState = {
  pending: [],
  head: null,
  standing: null,
};

const HOLD = Infinity;

/** One quick pass over a whole diagram: a stroke per unit, each as long as
 * its trace, and a large diagram takes several units per stroke so the pass
 * still ends within a few seconds. */
export function quickSteps(units: string[]): DrawStep[] {
  const perStroke = Math.ceil(units.length / MAX_STROKES);
  const steps: DrawStep[] = [];

  for (let i = 0; i < units.length; i += perStroke)
    steps.push({
      phase: "stroke",
      ms: STROKE_MS,
      targets: units.slice(i, i + perStroke),
    });

  return steps;
}

export const STROKE_MS = 220;

const MAX_STROKES = 16;

/** The timeline one arrival plays, from the whiteboard motion boards. */
export function stepsFor(cursor: AuthoringCursor): DrawStep[] {
  if (cursor.source === "standing") return [];

  if (cursor.source === "focus") return [{ phase: "attention", ms: HOLD }];
  const edit = cursor.edit;

  if (!edit) return [{ phase: null, ms: 300 }];

  if (edit.kind === "lens") return lensSteps(edit);

  if (edit.units?.length) return quickSteps(edit.units);

  switch (edit.type) {
    case "insert":
      if (edit.unit === "flow_node")
        return [
          { phase: "outline", ms: 420 },
          { phase: "fill", ms: 330 },
          ...(edit.linkId
            ? [{ phase: "outline" as const, ms: 450, targets: [edit.linkId] }]
            : []),
        ];

      if (edit.unit === "flow_edge") return [{ phase: "outline", ms: 450 }];

      if (edit.unit === "step")
        return [
          { phase: "outline", ms: 450 },
          { phase: "fill", ms: 250 },
        ];

      return [{ phase: "landing", ms: 680 }];
    case "update":
    case "replace":
      if (edit.unit) return [{ phase: "relabel", ms: 420 }];

      return updateSteps(edit);
    case "remove":
      // A block is erased on the board, then collapses; a unit is simply
      // gone from its diagram, so the courier only visits.
      return edit.unit
        ? [{ phase: null, ms: 400 }]
        : [{ phase: "erasing", ms: 660 }];
    case "move":
      return [{ phase: null, ms: 300 }];
  }
}

/** A lens row in the Diffs sidebar: an insert lands the row, a retitle
 * relabels it, a remove erases it. A targets-only update draws nothing. */
function lensSteps(edit: EditSummary): DrawStep[] {
  switch (edit.type) {
    case "insert":
      return [{ phase: "landing", ms: 520 }];
    case "remove":
      return [{ phase: "erasing", ms: 520 }];
    default:
      return edit.fields?.includes("title")
        ? [{ phase: "relabel", ms: 420 }]
        : [];
  }
}

/** Fields a reader cannot see change; a patch of only these draws nothing. */
const INVISIBLE_FIELDS = new Set(["defaultCollapsed"]);

/** Fields on a container that only its heading shows. */
const HEADING_FIELDS = new Set(["title", "tone"]);

const CONTAINERS = new Set(["section", "callout", "tutorial"]);

/** A block update draws what changed: nothing for a collapse patch, the
 * heading for a retitle, and never a container's children. */
function updateSteps(edit: EditSummary): DrawStep[] {
  const fields = edit.fields?.filter((field) => !INVISIBLE_FIELDS.has(field));

  if (fields && !fields.length) return [];

  if (CONTAINERS.has(edit.kind))
    return fields && fields.every((field) => HEADING_FIELDS.has(field))
      ? [{ phase: "retitle", ms: 420 }]
      : [];

  return [{ phase: "rewriting", ms: 1100 }];
}

const isUnitInsert = (entry: DrawEntry) =>
  entry.cursor.edit?.type === "insert" && entry.cursor.edit.unit !== undefined;

/** Fold a long run of unit inserts for one diagram into one quick pass. */
function coalesce(pending: DrawEntry[]): DrawEntry[] {
  const out: DrawEntry[] = [];

  for (let start = 0; start < pending.length; ) {
    const first = pending[start]!;

    if (!isUnitInsert(first)) {
      out.push(first);
      start++;
      continue;
    }

    let end = start;

    while (
      end < pending.length &&
      isUnitInsert(pending[end]!) &&
      pending[end]!.cursor.blockId === first.cursor.blockId
    )
      end++;

    if (end - start > WHOLE_THRESHOLD) {
      const last = pending[end - 1]!.cursor;

      const units = pending
        .slice(start, end)
        .flatMap(({ cursor }) => [
          cursor.targetId,
          ...(cursor.edit?.linkId ? [cursor.edit.linkId] : []),
        ]);

      out.push({
        cursor: {
          targetId: last.blockId,
          blockId: last.blockId,
          source: "edit",
          edit: {
            type: "insert",
            targetId: last.blockId,
            blockId: last.blockId,
            kind:
              first.cursor.edit?.unit === "step" ? "sequence" : "flow_diagram",
            units,
          },
          seq: last.seq,
        },
        steps: quickSteps(units),
      });
    } else out.push(...pending.slice(start, end));

    start = end;
  }

  return out;
}

function promote(state: DrawState, now: number): DrawState {
  if (state.head || !state.pending.length) return state;
  const [next, ...pending] = state.pending;
  const step = next!.steps[0]!;

  return {
    ...state,
    pending,
    head: { ...next!, index: 0, until: now + step.ms },
  };
}

/** A cursor arrived. A held focus gives way to it at once; one that is
 * already drawn only moves where the courier rests once the queue is empty. */
export function arrive(
  state: DrawState,
  cursor: AuthoringCursor,
  now: number,
  reduced = false,
): DrawState {
  if (cursor.source === "standing") return { ...state, standing: cursor };

  const steps = stepsFor(cursor).map((step) =>
    reduced && step.ms !== HOLD ? { ...step, ms: 0 } : step,
  );

  // Nothing to draw: the courier stays where he is.
  if (!steps.length) return state;

  const entry: DrawEntry = { cursor, steps };

  const held = state.head && state.head.until === HOLD;

  const next: DrawState = {
    ...state,
    head: held ? null : state.head,
    standing: held ? state.head!.cursor : state.standing,
    pending: coalesce([...state.pending, entry]),
  };

  return promote(next, now);
}

/** Time passed: finish whatever is due and start what follows. Each step
 * starts when the one before it was due, so a late tick (a hidden tab)
 * catches up instead of replaying the backlog. */
export function tick(state: DrawState, now: number): DrawState {
  let head = state.head;
  const pending = [...state.pending];
  let standing = state.standing;
  let changed = false;

  while (head && now >= head.until) {
    changed = true;
    const index = head.index + 1;

    if (index < head.steps.length) {
      head = atStep(head, index, head.until);
      continue;
    }

    standing = head.cursor;
    const at = head.until;
    const next = pending.shift();
    head = next ? atStep({ ...next, index: 0, until: at }, 0, at) : null;
  }

  return changed ? { pending, head, standing } : state;
}

/** The head moved on to `index`, starting when the step before it was due. */
const atStep = (head: DrawHead, index: number, from: number): DrawHead => ({
  ...head,
  index,
  until: from + head.steps[index]!.ms,
});

/** When the next tick is due, or null while holding or idle. */
export function nextDue(state: DrawState): number | null {
  return state.head && state.head.until !== HOLD ? state.head.until : null;
}

/** The cursor the courier stands on. */
export function standingCursor(state: DrawState): AuthoringCursor | null {
  return state.head?.cursor ?? state.standing;
}

/** Every element's phase: pending inserts wait unseen (a node's edge with
 * it, a whole diagram's units), the head is drawn one step at a time. */
export function phases(state: DrawState): Map<string, MotionPhase> {
  const map = new Map<string, MotionPhase>();

  for (const entry of state.pending) {
    const edit = entry.cursor.edit;

    if (edit?.type === "insert") map.set(entry.cursor.targetId, "queued");

    if (edit?.linkId) map.set(edit.linkId, "queued");

    for (const unit of edit?.units ?? []) map.set(unit, "queued");
  }

  const head = state.head;

  if (head) {
    const step = head.steps[head.index];

    // Everything a later step draws waits, unseen: a node's edge, a whole
    // diagram's remaining units.
    for (const later of head.steps.slice(head.index + 1))
      for (const target of later.targets ?? []) map.set(target, "queued");

    if (step?.phase)
      for (const target of step.targets ?? [head.cursor.targetId])
        map.set(target, step.phase);
  }

  return map;
}

/** The current items (blocks, lens rows), plus any item from the list
 * before that is being erased, put back after the nearest survivor that
 * preceded it. */
export function withErasedBlocks<Item extends { id?: string }>(
  nodes: Item[],
  before: Item[],
  phases: Map<string, string>,
): Item[] {
  const ids = new Set(nodes.map((node) => node.id));

  const erased = before.filter(
    (node) =>
      node.id !== undefined &&
      !ids.has(node.id) &&
      phases.get(node.id) === "erasing",
  );

  if (!erased.length) return nodes;
  const shown = [...nodes];

  for (const node of erased) {
    const index = before.indexOf(node);
    const survivor = before.slice(0, index).findLast((b) => ids.has(b.id));

    const at =
      survivor === undefined
        ? 0
        : shown.findIndex((b) => b.id === survivor.id) + 1;

    shown.splice(at, 0, node);
  }

  return shown;
}
