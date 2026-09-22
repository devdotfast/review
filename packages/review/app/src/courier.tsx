import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { AuthoringActivityContext } from "./authoring-activity";
import type { AuthoringCursor } from "./authoring-cursor";
import { CourierFigure } from "./courier-figure";
import { cursorElement } from "./cursor-element";
import { useReviewRoots } from "./review-root-context";

/** The cursor for the document on screen; undefined while viewing history. */
export const AuthoringCursorContext = createContext<
  AuthoringCursor | null | undefined
>(undefined);

const HOP_MS = 340;

const JUMP_MS = 540;

const LEAVE_MS = 440;

const SIT_AFTER_MS = 3000;

/** Where he stands on an element: its top edge, centered on a small thing,
 * a little in from the left on a wide one. */
function standingPoint(target: DOMRect, article: DOMRect) {
  return {
    x: target.left - article.left + Math.min(target.width / 2, 96),
    y: target.top - article.top,
  };
}

const reducedMotion = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;

type Idle = "none" | "march" | "sit";

/**
 * Stands on whatever the cursor names, hops when it moves, marches in place
 * while the lease is live and nothing is arriving, sits down after a while,
 * and hops up and out when the lease ends. Click him and he jumps. He is
 * absolutely positioned inside the document article and measured against it,
 * so scrolling costs nothing; layout changes re-measure him.
 */
export function Courier() {
  const roots = useReviewRoots();
  const activity = useContext(AuthoringActivityContext);
  const cursor = useContext(AuthoringCursorContext);
  const node = useRef<HTMLDivElement>(null);

  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null,
  );

  const [motion, setMotion] = useState<
    "hopping" | "jumping" | "leaving" | null
  >(null);

  const [idle, setIdle] = useState<Idle>("none");
  const [gone, setGone] = useState(false);

  const live =
    activity !== undefined &&
    activity !== "unknown" &&
    activity.workingCount > 0;

  const unknown = activity === "unknown";

  // Follow the cursor: resolve its element, measure, and keep measuring
  // while the document reflows around it. No cursor, no courier.
  useLayoutEffect(() => {
    const article = roots?.articleRef.current;

    if (!article || !cursor || gone) {
      setPosition(null);
      arrival.current = null;

      return;
    }

    let frame = 0;

    const measure = () => {
      frame = 0;
      const element = cursorElement(article, cursor);

      if (!element) return;

      const next = standingPoint(
        element.getBoundingClientRect(),
        article.getBoundingClientRect(),
      );

      setPosition((current) => {
        if (
          current &&
          Math.abs(current.x - next.x) < 1 &&
          Math.abs(current.y - next.y) < 1
        )
          return current;

        return next;
      });
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };

    measure();
    const resize = new ResizeObserver(schedule);
    resize.observe(article);
    const mutation = new MutationObserver(schedule);
    mutation.observe(article, { childList: true, subtree: true });

    return () => {
      resize.disconnect();
      mutation.disconnect();

      if (frame) cancelAnimationFrame(frame);
    };
  }, [roots, cursor, gone]);

  // A new cursor is a hop; the same spot re-measured after a reflow is a
  // slide. The first placement is neither.
  const arrival = useRef<{ x: number; y: number } | null>(null);
  const hopped = useRef<number>(undefined);

  useEffect(() => {
    if (!position || !cursor) return;
    const from = arrival.current;
    arrival.current = position;

    if (!from) {
      hopped.current = cursor.seq;

      return;
    }

    if (hopped.current === cursor.seq) return;
    const distance = Math.hypot(position.x - from.x, position.y - from.y);

    // The cursor moved but the spot has not yet: the measurement follows.
    if (distance < 1) return;
    hopped.current = cursor.seq;

    if (reducedMotion()) return;
    node.current?.style.setProperty(
      "--courier-arc",
      `${Math.min(72, 18 + distance * 0.28)}px`,
    );
    setIdle("none");
    setMotion("hopping");

    const timer = setTimeout(
      () => setMotion((current) => (current === "hopping" ? null : current)),
      HOP_MS,
    );

    return () => clearTimeout(timer);
  }, [position, cursor]);

  // With nothing arriving he marches, then sits.
  useEffect(() => {
    if (!live || motion === "hopping" || motion === "leaving" || gone) return;
    setIdle("march");
    const timer = setTimeout(() => setIdle("sit"), SIT_AFTER_MS);

    return () => clearTimeout(timer);
  }, [live, motion, cursor?.seq, gone]);

  // The lease ended: one last hop up and out, then nothing.
  useEffect(() => {
    if (live || activity === undefined || unknown || !position || gone) return;
    setIdle("none");
    setMotion("leaving");

    const timer = setTimeout(
      () => {
        setGone(true);
        setMotion(null);
        setPosition(null);
        arrival.current = null;
      },
      reducedMotion() ? 0 : LEAVE_MS,
    );

    return () => clearTimeout(timer);
  }, [live, unknown, activity === undefined, Boolean(position), gone]);

  // A lease that begins again brings him back.
  useEffect(() => {
    if (live && gone) setGone(false);
  }, [live, gone]);

  const jump = () => {
    if (reducedMotion() || motion === "leaving") return;
    setMotion(null);
    requestAnimationFrame(() => setMotion("jumping"));
    setTimeout(() => setMotion((m) => (m === "jumping" ? null : m)), JUMP_MS);
  };

  if (!position || gone || activity === undefined) return null;

  const description =
    activity !== "unknown" ? activity.focuses?.[0]?.description : undefined;

  return (
    <div
      ref={node}
      className="courier"
      data-state={unknown ? "unknown" : live ? "live" : "ended"}
      data-idle={idle}
      data-motion={motion ?? undefined}
      style={{ left: position.x, top: position.y }}
      aria-hidden={unknown || undefined}
    >
      <button
        type="button"
        className="courier-figure"
        aria-label={
          description
            ? `The agent's courier: ${description}. Press to make him jump.`
            : "The agent's courier. Press to make him jump."
        }
        onClick={jump}
      >
        {description && (
          <span className="courier-tag" aria-hidden="true">
            {description}
          </span>
        )}
        <span className="courier-arc">
          <span className="courier-body">
            <CourierFigure />
          </span>
        </span>
        <span className="courier-shadow" />
      </button>
    </div>
  );
}
