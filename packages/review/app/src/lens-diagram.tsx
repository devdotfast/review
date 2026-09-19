import type { Block } from "../../src/review-api/document";
import type { Source } from "../../src/source";
import { LensCallTree } from "./lens-call-tree";
import { ElementCounts } from "./lens-counts";
import { useReviewLenses } from "./review-lenses";

/** Compact diagrams are navigation: clicking evidence scrolls, never changes scope. */
export function LensDiagram({
  block,
  onReveal,
}: {
  block: Block;
  onReveal(source: Source, sectionId?: string): void;
}) {
  const lenses = useReviewLenses()!;

  const viewed = (sources: Source[]) =>
    lenses.stats(sources).state === "viewed";

  if (block.type === "sequence") {
    const actors = Object.entries(block.actors);
    const width = Math.max(280, actors.length * 100);

    const x = (id: string) =>
      50 +
      (actors.findIndex(([key]) => key === id) * (width - 100)) /
        Math.max(1, actors.length - 1);

    return (
      <div className="lens-sequence-scroll">
        <svg
          className="lens-sequence"
          width={width}
          height={60 + block.steps.length * 62}
          aria-label={block.title}
        >
          {actors.map(([id, label]) => (
            <g key={id}>
              <rect x={x(id) - 44} y={4} width={88} height={26} rx={4} />
              <text x={x(id)} y={21} textAnchor="middle">
                {label.length > 13 ? `${label.slice(0, 12)}…` : label}
              </text>
              <path
                className="lens-lifeline"
                d={`M${x(id)},32 V${52 + block.steps.length * 62}`}
              />
            </g>
          ))}
          {block.steps.map((step, index) => {
            const y = 66 + index * 62,
              from = x(step.from),
              to = x(step.to),
              source = step.source;

            return (
              <g
                key={step.id ?? index}
                className={`lens-sequence-step ${source && viewed([source]) ? "is-viewed" : ""}`}
                role={source ? "button" : undefined}
                tabIndex={source ? 0 : undefined}
                aria-label={step.label}
                onClick={() =>
                  source && onReveal(source, step.id ?? `${block.id}:${index}`)
                }
                onKeyDown={(event) => {
                  if (source && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    onReveal(source, step.id ?? `${block.id}:${index}`);
                  }
                }}
              >
                <title>
                  {step.label}
                  {source
                    ? ` · Total +${lenses.stats([source]).total.additions} −${lenses.stats([source]).total.deletions}`
                    : ""}
                </title>
                <rect
                  className="lens-step-hit"
                  x={0}
                  y={y - 22}
                  width={width}
                  height={48}
                />
                <text x={Math.min(from, to) + 5} y={y - 7}>
                  {step.label.length > 32
                    ? `${step.label.slice(0, 31)}…`
                    : step.label}
                </text>
                {source && (
                  <text
                    x={Math.min(from, to) + 5}
                    y={y + 17}
                    className="lens-element-counts"
                  >
                    <ElementCounts progress={lenses.stats([source])} />
                  </text>
                )}
                <path
                  strokeDasharray={step.style === "return" ? "4 3" : undefined}
                  d={
                    from === to
                      ? `M${from},${y} h30 v16 h-30`
                      : `M${from},${y} H${to}`
                  }
                />
                <path
                  d={
                    from === to
                      ? `M${to + 6},${y + 12} l-6,4 l6,4`
                      : `M${to + (to > from ? -6 : 6)},${y - 4} L${to},${y} l${to > from ? -6 : 6},4`
                  }
                />
              </g>
            );
          })}
        </svg>
      </div>
    );
  }

  if (block.type === "call_stack_diff")
    return <LensCallTree block={block} onReveal={onReveal} />;

  if (block.type === "database_lens")
    return (
      <div className="lens-database-paths">
        {block.useCases.map((useCase) => (
          <section key={useCase.id}>
            <strong>{useCase.label}</strong>
            {useCase.operations.map((operation) => (
              <button
                key={operation.id}
                className={viewed([operation.source]) ? "is-viewed" : ""}
                onClick={() => onReveal(operation.source)}
              >
                {operation.actor} → {operation.store}
                <small>{operation.label}</small>
              </button>
            ))}
          </section>
        ))}
      </div>
    );

  return (
    <p className="lens-diagram-note">
      Use the filtered file tree to explore this lens.
    </p>
  );
}
