import { isStringValue } from "@dev.fast/review-protocol";
import { useState } from "react";

import { assignReviewHeadingIds } from "./review-document-headings";
import type {
  HydratedReviewComponentNode,
  HydratedReviewElementNode,
  HydratedReviewNode,
} from "./review-document-hydrate";
import { reviewSectionSummary } from "./review-section-summary";
import {
  type TutorialRenderContext,
  tutorialFeatureVisible,
  tutorialViewVisible,
} from "./tutorial-render-visibility";

/** Nodes that may own a heading id: loose h2/h3 elements and sections. */
type HeadingOwner = HydratedReviewElementNode | HydratedReviewComponentNode;

/**
 * Project only conditional render visibility, not a second component renderer.
 * The source remains reusable across feature settings. Heading ids are
 * assigned here, once per projection; a heading that stays mounted keeps the
 * generated id a previous projection showed for it, just as the former DOM
 * collector retained existing IDs.
 */
export function projectReviewDocument(
  source: HydratedReviewNode[] | null,
  context: TutorialRenderContext,
  previous?: ReviewDocumentProjection,
): ReviewDocumentProjection {
  const generatedIds =
    previous?.source === source ? previous.generatedIds : undefined;

  const owners = new Map<HeadingOwner, HeadingOwner>();

  const project = (nodes: HydratedReviewNode[]): HydratedReviewNode[] =>
    nodes.flatMap((node): HydratedReviewNode[] => {
      if (node.type === "text") return [node];

      const children = project(node.children);

      if (node.type === "component") {
        if (node.name === "TutorialFeature" && !tutorialFeatureVisible(context))
          return [];

        if (
          node.name === "TutorialViewButton" &&
          !tutorialViewVisible(context, String(node.props.view))
        )
          return [];

        const props = { ...node.props };

        if (node.name === "ReviewSection")
          props.summary = reviewSectionSummary(children);

        const retained = generatedIds?.get(node);

        if (props.id === undefined && retained !== undefined)
          props.id = retained;

        const projected: HydratedReviewComponentNode = {
          ...node,
          props,
          children,
        };

        owners.set(node, projected);

        return [projected];
      }

      const props = { ...node.props };
      const retained = generatedIds?.get(node);

      if (props.id === undefined && retained !== undefined) props.id = retained;
      const projected: HydratedReviewElementNode = { ...node, props, children };
      owners.set(node, projected);

      return [projected];
    });

  const body = project(source ?? []);
  assignReviewHeadingIds(body);

  // Only generated ids are retained: a source node with no id of its own
  // received one from assignReviewHeadingIds, and it is always a string.
  const retainedIds = new Map<HeadingOwner, string>();

  for (const [node, projected] of owners) {
    const id = projected.props.id;

    if (node.props.id === undefined && isStringValue(id))
      retainedIds.set(node, id);
  }

  return { source, context, body, generatedIds: retainedIds };
}

interface ReviewDocumentProjection {
  source: HydratedReviewNode[] | null;
  context: TutorialRenderContext;
  body: HydratedReviewNode[];
  generatedIds: ReadonlyMap<HeadingOwner, string>;
}

/** React owns the retained projection, so abandoned renders cannot commit IDs. */
export function useReviewDocumentProjection(
  source: HydratedReviewNode[] | null,
  context: TutorialRenderContext,
): HydratedReviewNode[] {
  const [previous, setProjection] = useState(() =>
    projectReviewDocument(source, context),
  );

  if (
    previous.source !== source ||
    previous.context.tutorial !== context.tutorial ||
    previous.context.softwareMapEnabled !== context.softwareMapEnabled
  ) {
    const next = projectReviewDocument(source, context, previous);
    setProjection(next);

    return next.body;
  }

  return previous.body;
}
