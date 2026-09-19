import type { CoverageProgress } from "../../src/viewed-coverage";

export function ElementCounts({ progress }: { progress: CoverageProgress }) {
  const compact = (n: number) =>
    new Intl.NumberFormat("en", {
      notation: "compact",
      maximumFractionDigits: 1,
    })
      .format(n)
      .toLowerCase();

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
