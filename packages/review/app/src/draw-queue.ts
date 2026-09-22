import type { AuthoringCursor } from "./authoring-cursor";

/**
 * The draw queue: every cursor move the stream delivers is drawn in order,
 * one at a time, for as long as its drawing takes, and the courier stands on
 * the one being drawn. A focus is held on the board until the next arrival.
 * A burst of units for one diagram larger than WHOLE_THRESHOLD is drawn as
 * the whole diagram landing at once instead of a strobe of outlines.
 */
export type MotionPhase =
  | "queued"
  | "landing"
  | "outline"
  | "fill"
  | "rewriting"
  | "relabel"
  | "erasing"
  | "attention";

export interface DrawStep {
  phase: MotionPhase | null;
  /** Infinity holds the step until the next arrival. */
  ms: number;
}

export interface DrawEntry {
  cursor: AuthoringCursor;
  steps: DrawStep[];
  /** A collapsed burst: the phase goes on the block, not the units. */
  whole?: boolean;
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

/** The timeline one arrival plays, from the whiteboard motion boards. */
export function stepsFor(cursor: AuthoringCursor): DrawStep[] {
  if (cursor.source === "focus") return [{ phase: "attention", ms: HOLD }];
  const edit = cursor.edit;

  if (!edit) return [{ phase: null, ms: 300 }];

  switch (edit.type) {
    case "insert":
      if (edit.unit === "flow_node")
        return [
          { phase: "outline", ms: 420 },
          { phase: "fill", ms: 330 },
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
      return edit.unit
        ? [{ phase: "relabel", ms: 420 }]
        : [{ phase: "rewriting", ms: 1100 }];
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

const isUnitInsert = (entry: DrawEntry) =>
  entry.cursor.edit?.type === "insert" && entry.cursor.edit.unit !== undefined;

/** Fold a long run of unit inserts for one diagram into the diagram landing. */
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

      out.push({
        cursor: {
          targetId: last.blockId,
          blockId: last.blockId,
          source: "edit",
          edit: {
            type: "insert",
            targetId: last.blockId,
            blockId: last.blockId,
          },
          seq: last.seq,
        },
        steps: [{ phase: "landing", ms: 680 }],
        whole: true,
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

/** A cursor arrived. A held focus gives way to it at once. */
export function arrive(
  state: DrawState,
  cursor: AuthoringCursor,
  now: number,
  reduced = false,
): DrawState {
  const steps = stepsFor(cursor).map((step) =>
    reduced && step.ms !== HOLD ? { ...step, ms: 0 } : step,
  );

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

/** Every element's phase: pending inserts wait unseen, the head is drawn. */
export function phases(state: DrawState): Map<string, MotionPhase> {
  const map = new Map<string, MotionPhase>();

  for (const entry of state.pending)
    if (isUnitInsert(entry) || entry.cursor.edit?.type === "insert")
      map.set(entry.cursor.targetId, "queued");

  const head = state.head;

  if (head) {
    const phase = head.steps[head.index]?.phase;

    if (phase)
      map.set(head.whole ? head.cursor.blockId : head.cursor.targetId, phase);
  }

  return map;
}
