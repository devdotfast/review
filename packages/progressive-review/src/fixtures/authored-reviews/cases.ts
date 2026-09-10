import {
  PROSE_TAGS,
  type ProseTag,
  type ReviewAuthoringComponentName,
} from "../../review-document-data";

// All paths are relative to packages/progressive-review. Add a case here;
// the runner needs no new test code for another MDX document or helper module.
export interface AuthoredReviewCase {
  name: string;
  source:
    | { legacyFixture: string }
    | {
        directory: string;
        document?: string;
        helpers?: Record<string, string>;
        baseDirectory: string;
        headDirectory: string;
      };
  components: readonly ReviewAuthoringComponentName[];
  proseTags?: readonly ProseTag[];
  text?: readonly string[];
}

const tutorialComponents = [
  "AnchorLink",
  "CodePeek",
  "DatabaseLens",
  "DbUseCase",
  "DbWrite",
  "ReviewSection",
  "SequenceDiagram",
  "TutorialAuthoringConversation",
  "TutorialFeature",
  "TutorialKeymapPicker",
  "TutorialViewButton",
] as const;

const orderSource = {
  directory: "src/fixtures/document-json",
  helpers: { "data.ts.txt": "data.ts" },
  baseDirectory: "src/fixtures/authored-reviews/order-base",
  headDirectory: "src/fixtures/authored-reviews/order-head",
};

export const authoredReviewCases: readonly AuthoredReviewCase[] = [
  {
    name: "published bug-report PR",
    source: { legacyFixture: "schema4-bug-report-dialog" },
    components: ["ReviewSection"],
  },
  {
    name: "published OpenCode PR",
    source: { legacyFixture: "schema4-opencode-agentserver" },
    components: ["AnchorLink", "ReviewSection", "SequenceDiagram"],
  },
  {
    name: "published legacy tutorial",
    source: { legacyFixture: "schema4-three-minute-tour" },
    components: tutorialComponents,
  },
  {
    name: "current shipped tutorial",
    source: {
      directory: "tutorial",
      helpers: {
        "data.ts": "data.ts",
        "authoring-conversation.json": "authoring-conversation.json",
      },
      baseDirectory: "tutorial/sample-service",
      headDirectory: "tutorial/sample-service",
    },
    components: [...tutorialComponents, "TraceQuote"],
    text: ["shared server / source of truth"],
  },
  {
    name: "rich order reference",
    source: { ...orderSource, document: "order-review.mdx" },
    components: [
      "AnchorLink",
      "CallStackDiff",
      "CodePeek",
      "DatabaseLens",
      "DbRead",
      "DbUseCase",
      "DbWrite",
      "ReviewSection",
      "SequenceDiagram",
    ],
    text: ["Order persistence — café ☕", "Preserve & decode entities"],
  },
  {
    name: "complete Markdown reference",
    source: { ...orderSource, document: "markdown-reference.mdx" },
    components: ["ReviewSection"],
    proseTags: PROSE_TAGS,
    text: ["<preserved>", "Evidence with a"],
  },
];
