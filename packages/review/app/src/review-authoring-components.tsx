import type { ReviewDocumentComponentRegistry } from "../../src/review-document-data";
import { CallStackDiff } from "./call-stack-diff";
import { ReviewCodePeek } from "./CodePeek";
import { DatabaseLens } from "./database-lens";
import { SequenceDiagram } from "./diagrams";
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
} satisfies ReviewDocumentComponentRegistry;
