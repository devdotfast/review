import { type LensSource, sourceAnchor } from "../../src/lens-selection";
import type { Block } from "../../src/review-api/document";
import type { FileLineRange } from "../../src/source";
import { LensCallTree } from "./lens-call-tree";
import { FlowGraph } from "./flow-graph";
import { ElementCounts } from "./lens-counts";
import { useReviewLenses } from "./review-lenses";

/** Compact diagrams are navigation: clicking evidence scrolls, never changes scope. */
export function LensDiagram({
  block,
  onReveal,
}: {
  block: Block;
  onReveal(source: FileLineRange, sectionId?: string): void;
}) {
  const lenses = useReviewLenses()!;

  const viewed = (sources: LensSource[]) =>
    lenses.stats(lenses.resolve(sources)).state === "viewed";

  if (block.type === "flow_diagram")
    return (
      <FlowGraph
        requireReady
        block={block}
        direction="down"
        onSelect={(node) => {
          const source = node.attachments.flatMap(
            (attachment) => attachment.sources,
          )[0];

          if (source) onReveal(sourceAnchor(source), `${block.id}:${node.key}`);
        }}
      />
    );

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
              source = step.source,
              availability = source ? lenses.availability([source]) : "ready",
              ready = availability === "ready";

            return (
              <g
                key={step.id ?? index}
                className={`lens-sequence-step ${source && viewed([source]) ? "is-viewed" : ""}`}
                aria-disabled={!ready}
                style={{ opacity: ready ? undefined : 0.45 }}
                role={source ? "button" : undefined}
                tabIndex={source && ready ? 0 : undefined}
                aria-label={step.label}
                onClick={() =>
                  source &&
                  ready &&
                  onReveal(
                    sourceAnchor(source),
                    step.id ?? `${block.id}:${index}`,
                  )
                }
                onKeyDown={(event) => {
                  if (
                    source &&
                    ready &&
                    (event.key === "Enter" || event.key === " ")
                  ) {
                    event.preventDefault();
                    onReveal(
                      sourceAnchor(source),
                      step.id ?? `${block.id}:${index}`,
                    );
                  }
                }}
              >
                <title>
                  {step.label}
                  {!ready
                    ? availability === "pending"
                      ? " · Waiting for diff…"
                      : " · Source unavailable"
                    : source
                      ? ` · Total +${lenses.stats(lenses.resolve([source])).total.additions} −${lenses.stats(lenses.resolve([source])).total.deletions}`
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
                    {!ready ? (
                      availability === "pending" ? (
                        "…"
                      ) : (
                        "Unavailable"
                      )
                    ) : (
                      <ElementCounts
                        progress={lenses.stats(lenses.resolve([source]))}
                      />
                    )}
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
                disabled={lenses.availability([operation.source]) !== "ready"}
                className={viewed([operation.source]) ? "is-viewed" : ""}
                onClick={() => onReveal(sourceAnchor(operation.source))}
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
