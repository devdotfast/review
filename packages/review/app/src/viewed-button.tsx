import type { CoverageProgress } from "../../src/viewed-coverage";
import { useTooltip } from "./use-tooltip";

/**
 * The viewed box. Its look lives in the workbench's review.css so the diff
 * headers share it; the tooltip says what a click does, the aria-label what it
 * marks. With nothing to view it keeps its slot but hides.
 */
export function ViewedButton({
  progress,
  onClick,
  disabled,
  label,
}: {
  progress: CoverageProgress;
  onClick(): void;
  disabled?: boolean;
  /** What the box marks, e.g. the lens title. */
  label: string;
}) {
  const done = progress.state === "viewed";
  const empty = progress.total.additions + progress.total.deletions === 0;

  const tooltip = useTooltip(
    done
      ? "Click to mark as unviewed"
      : progress.state === "partial"
        ? "Click to mark all as viewed"
        : "Click to mark as viewed",
    { instant: true },
  );

  return (
    <button
      ref={empty ? undefined : tooltip}
      type="button"
      className={`review-viewed-check ${empty ? "is-empty" : ""}`}
      role="checkbox"
      aria-checked={progress.state === "partial" ? "mixed" : done}
      aria-label={`${done ? "Mark unviewed" : "Mark viewed"}: ${label}`}
      disabled={disabled || empty}
      onClick={onClick}
    />
  );
}
