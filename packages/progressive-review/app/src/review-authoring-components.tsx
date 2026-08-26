import type { ReviewAuthoringComponentRegistry } from "../../src/authoring";
import { CallStackDiff } from "./call-stack-diff";
import { ReviewCodePeek } from "./CodePeek";
import { DatabaseLens, DbRead, DbUseCase, DbWrite } from "./database-lens";
import { SequenceDiagram } from "./diagrams";
import { AnchorLink, ReviewSection } from "./review-components";
import { TraceQuote } from "./trace-quote";
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
  DbRead,
  DbUseCase,
  DbWrite,
  ReviewSection,
  SequenceDiagram,
  TraceQuote,
  TutorialFeature,
  TutorialKeymapPicker,
  TutorialViewButton,
} satisfies ReviewAuthoringComponentRegistry;
