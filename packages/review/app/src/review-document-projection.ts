import { useState } from "react";

import { assignReviewHeadingIds } from "./review-document-headings";
import type {
  HydratedReviewElementNode,
  HydratedReviewNode,
} from "./review-document-hydrate";
import { reviewSectionSummary } from "./review-section-summary";
import {
  type TutorialRenderContext,
  tutorialFeatureVisible,
  tutorialViewVisible,
} from "./tutorial-render-visibility";

/**
 * Project only conditional render visibility, not a second component renderer.
 * The source remains reusable across feature settings. Retain IDs on headings
 * that stay mounted, just as the former DOM collector retained existing IDs.
 */
export function projectReviewDocument(
  source: HydratedReviewNode[] | null,
  context: TutorialRenderContext,
  previous?: ReviewDocumentProjection,
): ReviewDocumentProjection {
  const visibleIds =
    previous?.source === source ? previous.visibleIds : undefined;

  const elements = new Map<
    HydratedReviewElementNode,
    HydratedReviewElementNode
  >();

  const project = (nodes: HydratedReviewNode[]): HydratedReviewNode[] =>
    nodes.flatMap((node): HydratedReviewNode[] => {
      if (node.type === "text") return [node];

      if (node.type === "component") {
        if (node.name === "TutorialFeature" && !tutorialFeatureVisible(context))
          return [];

        if (
          node.name === "TutorialViewButton" &&
          !tutorialViewVisible(context, String(node.props.view))
        )
          return [];
      }

      const children = project(node.children);

      if (node.type === "component") {
        return [
          {
            ...node,
            children,
            props:
              node.name === "ReviewSection"
                ? { ...node.props, summary: reviewSectionSummary(children) }
                : node.props,
          },
        ];
      }

      const props = { ...node.props };

      if (node.generatedHeadingId) {
        delete props.id;
        const retained = visibleIds?.get(node);

        if (retained !== undefined) props.id = retained;
      }

      const projected = { ...node, props, children };
      elements.set(node, projected);

      return [projected];
    });

  const body = project(source ?? []);
  assignReviewHeadingIds(body);

  return {
    source,
    context,
    body,
    visibleIds: new Map(
      [...elements].flatMap(([node, projected]) =>
        projected.props.id === undefined ? [] : [[node, projected.props.id]],
      ),
    ),
  };
}

interface ReviewDocumentProjection {
  source: HydratedReviewNode[] | null;
  context: TutorialRenderContext;
  body: HydratedReviewNode[];
  visibleIds: ReadonlyMap<HydratedReviewElementNode, string | number | boolean>;
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
