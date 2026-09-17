import {
  PROSE_TAGS,
  type ProseTag,
  type ReviewDocumentComponentName,
} from "../../review-document-data";

// All paths are relative to packages/review. Add a case here;
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
  components: readonly ReviewDocumentComponentName[];
  proseTags?: readonly ProseTag[];
  text?: readonly string[];
}

const tutorialComponents = [
  "AnchorLink",
  "CodePeek",
  "DatabaseLens",
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
    name: "rich order reference",
    source: { ...orderSource, document: "order-review.mdx" },
    components: [
      "AnchorLink",
      "CallStackDiff",
      "CodePeek",
      "DatabaseLens",
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
