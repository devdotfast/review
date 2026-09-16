import type { ComponentType } from "react";

import type { ReviewAuthoringComponentRegistry } from "../../src/authoring";
import { CallStackDiff, type CallStackDiffProps } from "./call-stack-diff";
import { ReviewCodePeek } from "./CodePeek";
import { DatabaseLens, type DatabaseLensProps } from "./database-lens";
import { SequenceDiagram, type SequenceDiagramProps } from "./diagrams";
import { AnchorLink, ReviewSection } from "./review-components";
import { TraceQuote } from "./trace-quote";
import { TutorialAuthoringConversation } from "./tutorial-authoring-conversation";
import {
  TutorialFeature,
  TutorialViewButton,
} from "./tutorial-dynamic-content";
import { TutorialKeymapPicker } from "./tutorial-keymap-picker";

export const reviewAuthoringComponents = {
  AnchorLink,
  CallStackDiff,
  CodePeek: ReviewCodePeek,
  DatabaseLens,
  ReviewSection,
  SequenceDiagram,
  TraceQuote,
  TutorialAuthoringConversation,
  TutorialFeature,
  TutorialKeymapPicker,
  TutorialViewButton,
} satisfies Omit<
  ReviewAuthoringComponentRegistry,
  | "CallStackDiff"
  | "SequenceDiagram"
  | "DatabaseLens"
  | "DbRead"
  | "DbUseCase"
  | "DbWrite"
> & {
  // The document stores canonical frames, steps and lens blocks; the authoring
  // registry still types authored MDX with anchor lists, messages and the
  // DbUseCase/DbRead/DbWrite markers, which lower into the lens at publish.
  // Part I moves the whole registry over.
  CallStackDiff: ComponentType<CallStackDiffProps>;
  SequenceDiagram: ComponentType<SequenceDiagramProps>;
  DatabaseLens: ComponentType<DatabaseLensProps>;
};
