import { isStringValue } from "@dev.fast/whiteboard-protocol";

import type {
  SequenceActorInput,
  SequenceDiagramProps,
  SequenceMessageCodeInput,
} from "./authoring";
import type { Step } from "./session-api/document";
import { slugify, uniqueId } from "./slug";

/** A sequence diagram as the document stores it: the canonical block minus
 * its `type` tag, with the id always present. */
export interface SequenceBlockProps {
  id: string;
  title: string;
  actors: Record<string, string>;
  steps: Step[];
}

/** Legacy sequences list messages between anchors or inline actors; the
 * document stores actors by name and steps with exactly one detail. Ids follow
 * the old runtime's rules so persisted tour state and deep links still resolve:
 * `sequence-<slug>` for the diagram, the anchor id for a step (suffixed
 * `--sequence-use-N` when an anchor repeats), and
 * `sequence-<slug>-message-N` for a step with only code. */
export function sequenceBlockFromProps(
  props: SequenceDiagramProps,
): SequenceBlockProps {
  const slug = slugify(props.label);
  const id = `sequence-${slug}`;
  const actors: Record<string, string> = {};
  const explicitActorIds = new Set<string>();

  for (const message of props.messages) {
    for (const actor of [message.from, message.to]) {
      if (actor.id) explicitActorIds.add(actor.id);
    }
  }

  const inlineActorIdsByLabel = new Map<string, string>();
  const usedActorIds = new Set(explicitActorIds);

  const actorName = (actor: SequenceActorInput): string => {
    if (actor.id) {
      actors[actor.id] = actor.label;

      return actor.id;
    }

    const existing = inlineActorIdsByLabel.get(actor.label);

    if (existing) return existing;

    const name = uniqueId(
      `inline-${slugify(actor.label) || "actor"}`,
      usedActorIds,
    );

    usedActorIds.add(name);
    inlineActorIdsByLabel.set(actor.label, name);
    actors[name] = actor.label;

    return name;
  };

  const reservedIds = new Set(
    props.messages.flatMap((message) =>
      message.anchor ? [message.anchor.id] : [],
    ),
  );

  const usedStepIds = new Set<string>();

  const stepId = (index: number, anchorId: string | undefined): string => {
    const base =
      anchorId ?? `sequence-${slug || "diagram"}-message-${index + 1}`;

    if (!usedStepIds.has(base)) {
      usedStepIds.add(base);

      return base;
    }

    const prefix = `${base}--sequence-use-${index + 1}`;
    let candidate = prefix;

    for (
      let suffix = 2;
      reservedIds.has(candidate) || usedStepIds.has(candidate);
      suffix += 1
    ) {
      candidate = `${prefix}-${suffix}`;
    }

    usedStepIds.add(candidate);

    return candidate;
  };

  const steps = props.messages.map((message, index): Step => {
    const from = actorName(message.from);
    const to = actorName(message.to);
    const code = codeBlock(message.code);

    const step: Step = {
      id: stepId(index, message.anchor?.id),
      type: "step",
      from,
      to,
      label: message.label,
      style: "call",
    };

    // Tour content precedence was code, then source: keep it.
    if (code) step.code = code;
    else if (message.anchor?.peek) step.source = message.anchor.peek;
    else step.explanation = message.label;

    return step;
  });

  return { id, title: props.label, actors, steps };
}

function codeBlock(
  code: SequenceMessageCodeInput | undefined,
): { language: string; text: string } | undefined {
  if (code === undefined) return undefined;

  if (isStringValue(code)) {
    const text = code.trim();

    return text ? { language: "text", text } : undefined;
  }

  const text = code.text.trim();

  if (!text) return undefined;

  return { language: code.language?.trim() || "text", text };
}
