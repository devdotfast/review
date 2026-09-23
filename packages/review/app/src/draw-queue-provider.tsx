import {
  type Context,
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { LeaseScope } from "../../src/review-api/activity";
import type { AuthoringCursor } from "./authoring-cursor";
import { cursorContext } from "./courier";
import {
  type DrawState,
  EMPTY_QUEUE,
  type MotionPhase,
  arrive,
  nextDue,
  phases,
  standingCursor,
  tick,
} from "./draw-queue";

/** Id for a callback a clock has scheduled; only ever passed back to that
 * same clock's `clearTimeout`. */
export type DrawQueueTimerHandle = number;

/** The time source that drives the queue: injectable so tests can advance
 * it by hand instead of racing the wall clock. */
export interface DrawQueueClock {
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => DrawQueueTimerHandle;
  clearTimeout: (handle: DrawQueueTimerHandle) => void;
}

const defaultClock: DrawQueueClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

/** One queue per lease scope: the document's blocks, the Diffs page's lens
 * rows. */
const MotionPhasesContexts: Record<
  LeaseScope,
  Context<Map<string, MotionPhase>>
> = {
  document: createContext<Map<string, MotionPhase>>(new Map()),
  lenses: createContext<Map<string, MotionPhase>>(new Map()),
};

/** Every element's phase, for a list that must keep an erased block around. */
export function useMotionPhases(
  scope: LeaseScope = "document",
): Map<string, MotionPhase> {
  return useContext(MotionPhasesContexts[scope]);
}

/** The phase an element is being drawn in, for its `data-motion`. */
export function useMotionPhase(
  id: string | undefined,
  scope: LeaseScope = "document",
): MotionPhase | undefined {
  const map = useContext(MotionPhasesContexts[scope]);

  return id === undefined ? undefined : map.get(id);
}

/**
 * Runs the draw queue on the stream's cursor moves and hands out two things:
 * the cursor the courier stands on (the head of the queue), and each
 * element's motion phase. Timers advance the queue; the pure model in
 * draw-queue.ts decides what happens. `undefined` is history: no queue.
 */
export function DrawQueueProvider({
  cursor,
  scope = "document",
  clock = defaultClock,
  children,
}: {
  cursor: AuthoringCursor | null | undefined;
  /** Which courier this queue drives; each scope has its own contexts. */
  scope?: LeaseScope;
  /** Defaults to `performance`/window timers; browser tests inject a
   * manual clock so phase transitions land on the test's schedule. */
  clock?: DrawQueueClock;
  children: ReactNode;
}) {
  const [state, setState] = useState<DrawState>(EMPTY_QUEUE);

  const [seen, setSeen] = useState<AuthoringCursor | null | undefined>(
    undefined,
  );

  // An arrival is folded in during this very render, so a block the same
  // version removed is already "erasing" when the document renders without it.
  if (cursor !== seen) {
    setSeen(cursor);

    if (!cursor) setState(EMPTY_QUEUE);
    else {
      const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
      setState((current) => arrive(current, cursor, clock.now(), reduced));
    }
  }

  useEffect(() => {
    const due = nextDue(state);

    if (due === null) return;

    // A timer can fire a hair before its due time; the step it was set for
    // is due regardless, or the queue would stall with no timer to follow.
    const timer = clock.setTimeout(
      () => setState((current) => tick(current, Math.max(due, clock.now()))),
      Math.max(0, due - clock.now()),
    );

    return () => clock.clearTimeout(timer);
  }, [state, clock]);

  const standing = standingCursor(state);
  const map = useMemo(() => phases(state), [state]);
  const CursorContext = cursorContext(scope);
  const PhasesContext = MotionPhasesContexts[scope];

  return (
    <CursorContext.Provider value={cursor === undefined ? undefined : standing}>
      <PhasesContext.Provider value={map}>{children}</PhasesContext.Provider>
    </CursorContext.Provider>
  );
}
