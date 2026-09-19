import { fileLensTargets } from "./blocks/file_lens.js";
import {
  type Element,
  ReviewInputError,
  type Source,
  elements,
} from "./document.js";
import type { Snapshot } from "./store.js";

const sourceText = (source: Source) =>
  `${source.side}/${source.file}:${source.fromLine}-${source.toLine}`;

/** A reading view of saved content, not another document format to maintain. */
export function documentText(
  snapshot: Snapshot,
  targetId?: string,
  full = false,
): string {
  const target =
    targetId === undefined
      ? undefined
      : elements(snapshot.document).find((item) => item.id === targetId);

  if (targetId !== undefined && !target)
    throw new ReviewInputError("Target not found in this version.", 404);
  const detailed = full || target !== undefined;

  const lines = [
    `# ${snapshot.title}`,
    `Review ${snapshot.reviewId} · version ${snapshot.version}`,
    "",
  ];

  const write = (depth: number, text: string) => {
    for (const line of text.split("\n")) lines.push("  ".repeat(depth) + line);
  };

  const code = (depth: number, value: { language: string; text: string }) => {
    write(depth, `Code (${value.language}):`);
    write(depth + 1, value.text);
  };

  const render = (element: Element, depth: number) => {
    const title = "title" in element ? element.title : undefined;
    write(depth, `[${element.id}] ${element.type}${title ? `: ${title}` : ""}`);
    const detail = (text: string) => write(depth + 1, text);

    switch (element.type) {
      case "section":
      case "callout":
        if (element.type === "callout") detail(`Tone: ${element.tone}`);

        if (element.type === "section" && element.status)
          detail(`Status: ${element.status}`);

        if (element.type === "section" && element.defaultCollapsed)
          detail("Initially collapsed");
        element.children.forEach((child) => render(child, depth + 1));
        break;
      case "markdown":
        detail(
          detailed
            ? element.markdown
            : element.markdown.split("\n")[0] +
                (element.markdown.includes("\n") ? " …" : ""),
        );
        break;
      case "code":
        if (element.caption) detail(element.caption);

        if (detailed) code(depth + 1, element);
        else
          detail(
            `${element.language}, ${element.text.split("\n").length} lines`,
          );
        break;
      case "divider":
        break;
      case "code_peek":
        detail(sourceText(element.source));

        if (element.caption) detail(element.caption);
        break;
      case "sequence":
        for (const [key, label] of Object.entries(element.actors))
          detail(`Actor ${key}: ${label}`);
        element.steps.forEach((step) => render(step, depth + 1));
        break;
      case "step":
        detail(
          `${element.from} → ${element.to}: ${element.label} (${element.style})`,
        );

        if (element.source) detail(sourceText(element.source));

        if (detailed && element.explanation) detail(element.explanation);

        if (detailed && element.code) code(depth + 1, element.code);
        break;
      case "call_stack_diff":
        for (const side of ["base", "head"] as const) {
          detail(`${side}:`);
          element[side].forEach((frame) => {
            write(
              depth + 2,
              `${frame.label ?? frame.key ?? "Frame"}: ${sourceText(frame.source)}`,
            );

            if (detailed && frame.via)
              write(depth + 3, `${frame.via.kind}: ${frame.via.reason}`);
          });
        }

        break;
      case "database_lens":
        for (const [key, label] of Object.entries(element.actors))
          detail(`Actor ${key}: ${label}`);

        for (const [key, store] of Object.entries(element.stores)) {
          detail(`Store ${key}: ${store.label} (${store.storage})`);

          for (const [key, collection] of Object.entries(store.collections)) {
            write(depth + 2, `Collection ${key}: ${collection.label}`);

            if (detailed)
              for (const [key, field] of Object.entries(collection.fields)) {
                write(
                  depth + 3,
                  `${key}: ${field.label}, ${field.dataType}${field.primaryKey ? ", primary key" : ""}${field.nullable ? ", nullable" : ""}${field.references ? ` → ${field.references.store}.${field.references.collection}.${field.references.field}` : ""}`,
                );
              }
          }
        }

        for (const useCase of element.useCases) {
          detail(`Use case: ${useCase.label}`);

          if (detailed && useCase.summary) write(depth + 2, useCase.summary);

          for (const operation of useCase.operations)
            write(
              depth + 2,
              `${operation.actor}: ${operation.kind} ${operation.store}.${operation.collection}${operation.field ? `.${operation.field}` : ""} — ${operation.label} (${sourceText(operation.source)})`,
            );
        }

        break;
      case "image":
        detail(`${element.alt} (asset: ${element.assetId})`);

        if (element.caption) detail(element.caption);
        break;
      case "trace_quote":
        detail(`${element.traceId}, event ${element.eventId}`);
        detail(element.text);
        break;
      case "file_lens":
        for (const target of fileLensTargets(element)) {
          if (target.kind === "files")
            detail(`Files: ${target.patterns.join(", ")}`);
          else
            for (const source of target.sources)
              detail(`Range: ${sourceText(source)}`);
        }
        break;
      case "software_map":
        detail(
          `Map: ${element.mapVersionId}${element.focusElementId ? `, focus: ${element.focusElementId}` : ""}`,
        );
        break;
    }
  };

  (target ? [target] : snapshot.document).forEach((element) =>
    render(element, 0),
  );

  if (!snapshot.document.length) lines.push("(Empty review)");

  if (!detailed && snapshot.document.length)
    lines.push(
      "",
      "Use targetId for one component's complete content, or full:true for the whole review.",
    );

  return lines.join("\n");
}
