import type { TutorialStepId } from "@dev.fast/review-protocol";

export type TutorialChapterId =
  | "welcome"
  | "commits"
  | "comments"
  | "diagrams"
  | "finish";

export type TutorialStepCompletion =
  | "external"
  | "click"
  | "inline-hover"
  | "inline-navigation"
  | "comment"
  | "finish";

export interface TutorialChapterDefinition {
  id: TutorialChapterId;
  title: string;
}

export interface TutorialStepDefinition {
  id: TutorialStepId;
  chapter: TutorialChapterId;
  title: string;
  instruction: string;
  completion: TutorialStepCompletion;
  targetSelector: string;
  /** Marks the first code line in the target that matches, with its gutter
      comment control shown, so the reader sees where to start. */
  lineMatcher?: RegExp;
  requiresSoftwareMap?: boolean;
}

/* A function or method signature that opens a body, or a const/let/var
   declaration. `\s` also covers the non-breaking spaces Monaco renders. */
const DECLARATION_LINE =
  /^\s*(?:export\s+)?(?:async\s+)?(?:function\b|const\b|let\b|var\b)|^\s*(?:(?:public|private|protected|static|async|readonly)\s+)*[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/;

export const TUTORIAL_CHAPTERS: readonly TutorialChapterDefinition[] = [
  { id: "welcome", title: "Welcome" },
  { id: "commits", title: "Commits and diffs" },
  { id: "comments", title: "Comments are threads" },
  { id: "diagrams", title: "Interactive Diagrams" },
  { id: "finish", title: "Get help" },
];

const tutorialSteps: readonly TutorialStepDefinition[] = [
  {
    id: "chooseKeymap",
    chapter: "welcome",
    title: "Choose your keybindings",
    instruction:
      "Choose the editor keys you want to use while reading Reviews.",
    completion: "external",
    targetSelector: ".tutorial-keymap-picker",
  },
  {
    id: "showHover",
    chapter: "welcome",
    title: "Inspect a symbol",
    instruction:
      "Move the pointer over a typed symbol in the live editor to see its type information.",
    completion: "inline-hover",
    targetSelector: '[data-review-section="Welcome"] .review-inline-editor',
  },
  {
    id: "gotoDefinition",
    chapter: "welcome",
    title: "Navigate the code",
    instruction:
      "Use Go to Definition on a symbol—the same command you use in your editor.",
    completion: "inline-navigation",
    targetSelector: '[data-review-section="Welcome"] .review-inline-editor',
  },
  {
    id: "openPeek",
    chapter: "welcome",
    title: "Follow the prose",
    instruction:
      "Select the order creation path in the prose to open its focused code.",
    completion: "click",
    targetSelector: '[data-review-section="Welcome"] a[data-review-anchor-id]',
  },
  {
    id: "openCommits",
    chapter: "commits",
    title: "Inspect the commits",
    instruction:
      "Open Commits to see how the change was built in author order.",
    completion: "click",
    targetSelector:
      'button[aria-label="Commits"], .tutorial-view-button[data-tutorial-view="commits"]',
  },
  {
    id: "openDiff",
    chapter: "commits",
    title: "Open a focused diff",
    instruction:
      "Open the sample commit's diff to inspect only the change it introduced.",
    completion: "click",
    targetSelector: ".review-commit-open",
  },
  {
    id: "leaveComment",
    chapter: "comments",
    title: "Start a thread",
    instruction:
      "Move over the code, use the comment control in the left gutter, and write a note.",
    completion: "comment",
    // The reader arrives here from the commit diff, so the open Diff view's
    // editors count as well as the document's code block. Only the visible
    // one is marked.
    targetSelector: [
      '[data-review-section="Comments are threads"] .review-inline-editor',
      ".review-diff-view:not(.review-diff-view--preloaded) .monaco-diff-editor .editor.modified",
    ].join(", "),
    lineMatcher: DECLARATION_LINE,
  },
  {
    id: "openSequence",
    chapter: "diagrams",
    title: "Walk the sequence",
    instruction:
      "Open the sequence Tour, then select its messages to follow the supporting code.",
    completion: "external",
    targetSelector:
      '[data-review-section="Interactive Diagrams"] .sequence-diagram .diagram-tour-button',
  },
  {
    id: "openMap",
    chapter: "diagrams",
    title: "Explore the software map",
    instruction:
      "Open Map to move from the sample system to its components and code.",
    completion: "click",
    targetSelector:
      'button[aria-label="Map (Experimental)"], .tutorial-view-button[data-tutorial-view="map"]',
    requiresSoftwareMap: true,
  },
  {
    id: "openDatabase",
    chapter: "diagrams",
    title: "Inspect the database flow",
    instruction:
      "Open the database Tour to follow the order write from the service into storage.",
    completion: "external",
    targetSelector:
      '[data-review-section="Interactive Diagrams"] .database-lens .diagram-tour-button',
  },
  {
    id: "getHelp",
    chapter: "finish",
    title: "Know where to get help",
    instruction:
      "Use Settings to manage installed Review skills, or Getting Started to revisit setup and this tour.",
    completion: "finish",
    targetSelector: '[data-review-section="Get help"] .review-section-body',
  },
];

export function availableTutorialSteps(
  softwareMapEnabled: boolean,
): readonly TutorialStepDefinition[] {
  return tutorialSteps.filter(
    (step) => !step.requiresSoftwareMap || softwareMapEnabled,
  );
}

export function tutorialChapter(
  id: TutorialChapterId,
): TutorialChapterDefinition {
  return TUTORIAL_CHAPTERS.find((chapter) => chapter.id === id)!;
}
