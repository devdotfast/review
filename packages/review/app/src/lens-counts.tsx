import type { CoverageProgress } from "../../src/viewed-coverage";
import { compactDiffCount as compact } from "./diff-count";

export function ElementCounts({ progress }: { progress: CoverageProgress }) {
  return progress.state === "viewed" ? (
    <tspan>✓</tspan>
  ) : (
    <>
      <tspan className="diff-count-added">
        +{compact(progress.remaining.additions)}
      </tspan>
      <tspan dx="6" className="diff-count-removed">
        −{compact(progress.remaining.deletions)}
      </tspan>
    </>
  );
}

/** The same counts for an HTML caption, outside SVG text. */
export function ElementCountsText({
  progress,
}: {
  progress: CoverageProgress;
}) {
  return progress.state === "viewed" ? (
    <span>✓</span>
  ) : (
    <>
      <span className="diff-count-added">
        +{compact(progress.remaining.additions)}
      </span>{" "}
      <span className="diff-count-removed">
        −{compact(progress.remaining.deletions)}
      </span>
    </>
  );
}
