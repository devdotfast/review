import type { JsonPrimitive } from "@dev.fast/review-protocol";
import { isObjectValue } from "@dev.fast/review-protocol";
import type { MDXComponents } from "mdx/types";
import type { ComponentType } from "react";

import type { AnchorRef } from "../../src/authoring";
import type { SequenceRef } from "./diagrams";
import type { NormalizedSoftwareModel } from "./software-map/model";

/** The compiled MDX body of a review document. */
export type ReviewDocumentComponent = ComponentType<{
  components?: MDXComponents;
}>;

/**
 * One export of a compiled review document module. Authors export software
 * models, sequences and anchors, possibly nested in their own containers, so
 * exports are walked structurally.
 */
export type ReviewDocumentExport =
  | NormalizedSoftwareModel
  | SequenceRef
  | AnchorRef
  | ReviewDocumentComponent
  | JsonPrimitive
  | undefined
  | readonly ReviewDocumentExport[]
  | { readonly [name: string]: ReviewDocumentExport };

export type ReviewDocumentModuleExports = Record<string, ReviewDocumentExport>;

/** Exports whose fields can hold anchors: models, refs and author containers. */
type ReviewDocumentExportContainer = Exclude<
  ReviewDocumentExport,
  JsonPrimitive | undefined | ReviewDocumentComponent
>;

export interface ReviewDocumentModuleInput {
  slug: string;
  routePath: string;
  filePath: string;
  title: string;
  modelNames: string[];
  models: ReviewDocumentModuleExports;
  Component: ReviewDocumentComponent | null;
  isDefault: boolean;
}

export interface ReviewDocumentEntry {
  slug: string;
  routePath: string;
  filePath: string;
  title: string;
  documentSoftwareModels: NormalizedSoftwareModel[];
  anchors: ReadonlyMap<string, AnchorRef>;
  anchorContents: ReadonlyMap<string, string>;
  Component: ReviewDocumentComponent;
  isDefault: boolean;
}

export type ReadyReviewDocumentEntry = ReviewDocumentEntry;

export function createActiveReviewDocument(
  input: ReviewDocumentModuleInput,
): ReadyReviewDocumentEntry {
  if (!input.Component) {
    throw new Error(
      `Review document ${input.filePath} did not export a React component.`,
    );
  }
  const documentSoftwareModels = input.modelNames.flatMap((name) => {
    const model = input.models[name];
    return isSoftwareModel(model) ? [model] : [];
  });
  const { anchors, anchorContents } = collectReviewAnchors(input.models);
  return {
    slug: input.slug,
    routePath: input.routePath,
    filePath: input.filePath,
    title: input.title,
    documentSoftwareModels,
    anchors,
    anchorContents,
    Component: input.Component,
    isDefault: input.isDefault,
  };
}

function collectReviewAnchors(models: ReviewDocumentModuleExports) {
  const anchors = new Map<string, AnchorRef>();
  const anchorContents = new Map<string, string>();
  const visited = new Set<object>();
  const visit = (value: ReviewDocumentExport): void => {
    if (!isReviewDocumentExportContainer(value)) return;
    if (visited.has(value)) return;
    visited.add(value);
    if (isSequenceRefExport(value)) {
      for (const message of value.messages) {
        if (!message.code) continue;
        const existing = anchorContents.get(message.anchor.id);
        if (existing !== undefined && existing !== message.code.text) {
          throw new Error(
            `Review anchor id "${message.anchor.id}" has more than one authored content body.`,
          );
        }
        anchorContents.set(message.anchor.id, message.code.text);
      }
    }
    if (isAnchorRefExport(value)) {
      const existing = anchors.get(value.id);
      if (existing && existing !== value) {
        throw new Error(
          `Review anchor id "${value.id}" is defined more than once.`,
        );
      }
      anchors.set(value.id, value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    for (const entry of Object.values(value)) visit(entry);
  };
  for (const value of Object.values(models)) visit(value);
  return { anchors, anchorContents };
}

function isReviewDocumentExportContainer(
  value: ReviewDocumentExport,
): value is ReviewDocumentExportContainer {
  return isObjectValue(value);
}

function isSequenceRefExport(
  value: ReviewDocumentExportContainer,
): value is SequenceRef {
  return "__kind" in value && value.__kind === "review-sequence-ref";
}

function isAnchorRefExport(
  value: ReviewDocumentExportContainer,
): value is AnchorRef {
  return "__kind" in value && value.__kind === "db-anchor-ref";
}

function isSoftwareModel(
  value: ReviewDocumentExport,
): value is NormalizedSoftwareModel {
  return (
    isReviewDocumentExportContainer(value) &&
    "elements" in value &&
    Array.isArray(value.elements) &&
    "relationships" in value &&
    Array.isArray(value.relationships)
  );
}
