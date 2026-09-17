import { type JsonValue, isJsonObject } from "@dev.fast/json";
import {
  ReviewAgentTraceEventSchema,
  ReviewAgentTraceSessionSchema,
} from "@dev.fast/trace-protocol";
import { z } from "zod";

// Version 3: the desktop serves prebuilt revisions instead of building them.
// (Version 2 added the bundled-CLI discovery fields.)
export const REVIEW_DESKTOP_DISCOVERY_VERSION = 3;

// Version 5: document and software-map bundles are JSON.
export const REVIEW_SCHEMA_VERSION = 5;

const requiredString = z
  .string({ error: "must be a string" })
  .refine((value) => value.trim().length > 0, "must be a string");

const stringAllowEmpty = z.string({ error: "must be a string" });

const positiveInteger = z
  .number({ error: "must be a positive integer" })
  .int("must be a positive integer")
  .positive("must be a positive integer");

const nonNegativeInteger = z
  .number({ error: "must be a non-negative integer" })
  .int("must be a non-negative integer")
  .nonnegative("must be a non-negative integer");

const reviewDiffSideSchema = z.enum(["base", "head"], {
  error: "must be base or head",
});

export const reviewViewSchema = z.enum([
  "review",
  "commits",
  "diff",
  "map",
  "trace",
]);

export type ReviewView = z.infer<typeof reviewViewSchema>;

const reviewThemeSchema = z.enum(["light", "dark"], {
  error: "must be light or dark",
});

function urlSchema(
  output: "href" | "origin",
  constraint?: (url: URL) => string | null,
) {
  return requiredString.transform((value, context) => {
    let url: URL;

    try {
      url = new URL(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "must be an absolute URL",
      });

      return z.NEVER;
    }

    const error = constraint?.(url);

    if (error) {
      context.addIssue({ code: "custom", message: error });

      return z.NEVER;
    }

    return output === "origin" ? url.origin : url.href;
  });
}

const absoluteUrlSchema = urlSchema("href");

const loopbackUrlSchema = urlSchema("href", (url) =>
  url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port
    ? null
    : "must use http://127.0.0.1:<port>",
).transform((value) => value.replace(/\/$/, ""));

const loopbackOriginSchema = urlSchema("origin", (url) =>
  url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port
    ? null
    : "must use http://127.0.0.1:<port>",
);

export function normalizeReviewRoutePath(pathname: string): string {
  const pathnameOnly = String(pathname || "/").split(/[?#]/)[0] || "/";
  let end = pathnameOnly.length;

  while (end > 1 && pathnameOnly.charCodeAt(end - 1) === 47) end--;
  const trimmed = pathnameOnly.slice(0, end) || "/";

  return trimmed === "/"
    ? "/"
    : trimmed.startsWith("/")
      ? trimmed
      : `/${trimmed}`;
}

const routePathSchema = requiredString.transform(normalizeReviewRoutePath);

export const ReviewRuntimeConfigSchema = z.strictObject({
  serverUrl: loopbackOriginSchema,
  sessionUrl: loopbackUrlSchema,
  routePath: routePathSchema,
  sessionId: requiredString,
  token: stringAllowEmpty,
  wasmUrl: absoluteUrlSchema,
  appVersion: requiredString.max(100),
  theme: reviewThemeSchema,
  host: z.literal("desktop"),
});

export type ReviewRuntimeConfig = z.infer<typeof ReviewRuntimeConfigSchema>;

export type ReviewHost = ReviewRuntimeConfig["host"];

export type ReviewTheme = ReviewRuntimeConfig["theme"];

export type ReviewDiffSide = z.infer<typeof reviewDiffSideSchema>;

/** How embedded diffs lay out: base and head side by side, or one column. */
export const REVIEW_DIFF_LAYOUTS = ["split", "unified"] as const;

export type ReviewDiffLayout = (typeof REVIEW_DIFF_LAYOUTS)[number];

export interface ReviewDisposable {
  dispose(): void;
}

export type ReviewInlineEditorHeightMode = "capped" | "content";

export interface ReviewInlineEditorRange {
  startLine: number;
  endLine: number;
  side?: ReviewDiffSide;
}

export interface ReviewInlineEditorSpec {
  container: HTMLElement;
  path: string;
  title: string;
  description?: string;
  side: ReviewDiffSide;
  ranges: readonly ReviewInlineEditorRange[];
  /** Original authored selections, before display ranges are merged. */
  countRanges?: readonly ReviewInlineEditorRange[];
  heightMode: ReviewInlineEditorHeightMode;
  active: boolean;
  onDidFocus?: () => void;
  onDidOpen?: () => void;
  onDidNavigate?: () => void;
  onDidShowHover?: () => void;
}

export interface ReviewFindQuery {
  text: string;
  matchCase: boolean;
  wholeWord: boolean;
  isRegex: boolean;
}

export interface ReviewInlineFindResult {
  matchCount: number;
}

export interface ReviewInlineFindSpec {
  path: string;
  side: ReviewDiffSide;
  ranges: readonly ReviewInlineEditorRange[];
}

export interface ReviewInlineEditorHandle extends ReviewDisposable {
  readonly height: number;
  setActive(active: boolean): void;
  setCollapsed(collapsed: boolean): void;
  onDidChangeHeight(listener: (height: number) => void): ReviewDisposable;
  onDidError(listener: (message: string) => void): ReviewDisposable;
  setFindQuery(query: ReviewFindQuery): Promise<ReviewInlineFindResult>;
  revealFindMatch(index: number): void;
  clearActiveFindMatch(): void;
  clearFind(): void;
}

export interface ReviewInlineEditorFactory {
  create(spec: ReviewInlineEditorSpec): ReviewInlineEditorHandle;
  find(
    spec: ReviewInlineFindSpec,
    query: ReviewFindQuery,
  ): Promise<ReviewInlineFindResult>;
}

export interface ReviewDiffViewSpec {
  container: HTMLElement;
  scope?: ReviewCommitScope;
}

export interface ReviewDiffViewHandle extends ReviewDisposable {
  focus(): void;
  onDidError(listener: (message: string) => void): ReviewDisposable;
}

/**
 * Mounts the changed-files diff UI — file list and multi-diff widget — into an
 * app-owned container. `create` returns at once and initializes the widget
 * asynchronously; a failed initialization arrives through `onDidError`.
 */
export interface ReviewDiffViewFactory {
  create(spec: ReviewDiffViewSpec): ReviewDiffViewHandle;
  /** Returns the parsed full diff that backs the native diff view. */
  files?(scope?: ReviewCommitScope): Promise<readonly ReviewDiffFileWire[]>;
}

export interface ReviewCommitScope {
  commit: string;
}

export interface ReviewCanvasDiagnostic {
  level: "error" | "warning";
  source: string;
  message: string;
  stack?: string;
}

export interface ReviewCanvasBridge {
  readonly appSessionId?: string;
  readonly config: ReviewRuntimeConfig;
  readonly inlineEditors: ReviewInlineEditorFactory;
  readonly diffView: ReviewDiffViewFactory;
  request(url: string, init?: RequestInit): Promise<Response>;
  post(request: ReviewVerbRequest): Promise<ReviewVerbResponse>;
  subscribe(listener: (event: ReviewSurfaceEvent) => void): ReviewDisposable;
  currentTheme(): ReviewTheme;
  onDidChangeTheme(listener: (theme: ReviewTheme) => void): ReviewDisposable;
  // The diff layout is app-wide and backed by the `diffEditor.renderSideBySide`
  // setting, so a choice outlives the session and the app restart.
  currentDiffLayout(): ReviewDiffLayout;
  setDiffLayout(layout: ReviewDiffLayout): Promise<void>;
  onDidChangeDiffLayout(
    listener: (layout: ReviewDiffLayout) => void,
  ): ReviewDisposable;
  ready(): void;
  reportDiagnostic?(diagnostic: ReviewCanvasDiagnostic): void;
}

/**
 * Install state and actions the workbench hands to the Home canvas. `apply`,
 * `skip`, and `enablePrompts` resolve with the refreshed status so the card can
 * re-render without a full canvas update.
 */
export interface ReviewCanvasInstallContent {
  status: ReviewCliInstallStatus;
  apply(request: {
    targets: readonly ReviewCliInstallTarget[];
    shim?: boolean;
    fff?: boolean;
    trace?:
      | true
      | {
          endpoint?: string;
          bucket?: string;
          region?: string;
          key?: string;
          secret?: string;
        };
  }): Promise<ReviewCliInstallStatus>;
  remove(request: {
    targets: readonly ReviewCliInstallTarget[];
    shim?: boolean;
    fff?: boolean;
    trace?: true;
  }): Promise<ReviewCliInstallStatus>;
  decline(): Promise<ReviewCliInstallStatus>;
  skip(): Promise<ReviewCliInstallStatus>;
  enablePrompts(): Promise<ReviewCliInstallStatus>;
}

/**
 * Install status handed to the Home canvas so it can show a one-line setup
 * banner when the install needs attention. `open` navigates to the Agent
 * Setup page.
 */
export interface ReviewCanvasHomeSetup {
  status: ReviewCliInstallStatus;
  open(): void;
}

/**
 * Onboarding progress for the Welcome pane: which of the three steps the user
 * finished. `tutorialChecked` counts the checklist steps the tutorial
 * recorded, out of `tutorialTotal`.
 */
export interface ReviewCanvasOnboarding {
  installed: boolean;
  tutorialChecked: number;
  tutorialTotal: number;
  // At least one published review exists. Drafts and the tutorial are not in
  // the review list, so this only counts a real published review.
  published: boolean;
}

// The workbench owns the theme and the keymap; the canvas only names a choice.
// Both lists mirror the workbench side (`reviewThemeChoice.ts` and
// `REVIEW_KEYMAPS` in `reviewConfigurationDefaults.ts`).
export const REVIEW_THEME_CHOICES = ["dark", "light", "system"] as const;

export type ReviewThemeChoice = (typeof REVIEW_THEME_CHOICES)[number];

export const REVIEW_KEYMAP_CHOICES = ["none", "vim", "emacs"] as const;

export type ReviewKeymapChoice = (typeof REVIEW_KEYMAP_CHOICES)[number];

export const REVIEW_TUTORIAL_STEP_IDS = [
  "openPeek",
  "gotoDefinition",
  "showHover",
  "openCommits",
  "openDiff",
  "openSequence",
  "openMap",
  "openDatabase",
  "getHelp",
  "chooseKeymap",
  "openTraceQuote",
] as const;

export type TutorialStepId = (typeof REVIEW_TUTORIAL_STEP_IDS)[number];

export const REVIEW_TUTORIAL_PROGRESS_STORAGE_KEY =
  "review.tutorial.progress.v1";

export interface TutorialProgressV1 {
  version: 1;
  checked: TutorialStepId[];
  dismissed: boolean;
}

export interface ReviewCanvasTutorialContent {
  reviewUuid: string;
  progress: TutorialProgressV1;
  keymap: ReviewKeymapChoice;
}

export interface ReviewCanvasTutorialBridge {
  content: ReviewCanvasTutorialContent;
  setStep(step: TutorialStepId, checked: boolean): void;
  dismiss(): void;
  reopen(): void;
  selectKeymap(keymap: ReviewKeymapChoice): Promise<void>;
  // Closes the tutorial tab. The tutorial is not in the review store, so
  // there is nothing to dismiss — finishing it just means closing it.
  close(): void;
}

/**
 * How long a dismissed review waits before the reaper deletes it. The server
 * owns the stored value, but the workbench needs the same default so the
 * Settings page can still show a truthful row when the read fails.
 */
export const DEFAULT_DISMISSED_RETENTION_DAYS = 30;

/**
 * Settings state and actions the workbench hands to the Settings canvas. Every
 * setter resolves with the value that actually landed, so a row re-renders from
 * the authoritative result instead of an optimistic one.
 */
export interface ReviewCanvasSettingsContent {
  // Backed by the `review.telemetry.enabled` workbench setting, which the
  // review server and the CLI both read.
  telemetryEnabled: boolean;
  setTelemetryEnabled(enabled: boolean): Promise<boolean>;
  theme: ReviewThemeChoice;
  setTheme(choice: ReviewThemeChoice): Promise<ReviewThemeChoice>;
  keymap: ReviewKeymapChoice;
  // A keymap only takes effect after the extension host restarts, so the
  // workbench offers the window reload. The page never forces one.
  setKeymap(choice: ReviewKeymapChoice): Promise<ReviewKeymapChoice>;
  // The one value here that is not a workbench setting. The reaper runs inside
  // the review server, which never reads workbench configuration, so this lives
  // in the server preferences file. `null` turns reaping off.
  dismissedRetentionDays: number | null;
  setDismissedRetentionDays(days: number | null): Promise<number | null>;
  softwareMapEnabled: boolean;
  setSoftwareMapEnabled(enabled: boolean): Promise<boolean>;
  manageExtensions(): void;
  // Agent installs are managed here too, so they stay reachable once Home
  // has reviews and no longer shows the Welcome rail. Absent when the
  // install status endpoint is unavailable.
  install?: ReviewCanvasInstallContent;
}

export type ReviewDocumentLoad =
  | { state: "ready"; contentHash: string; data: JsonValue }
  | {
      state: "needs-republish";
      reviewUuid: string;
      mapStale: boolean;
    }
  | { state: "unavailable"; message: string; currentReviewUuid?: string };

export type ReviewSoftwareMapLoad =
  | { state: "ready"; contentHash: string; head: JsonValue; base: JsonValue }
  | { state: "needs-republish"; reviewUuid: string }
  | { state: "unavailable"; message: string; currentReviewUuid?: string };

export interface ReviewApiSourceLocation {
  version: number;
  file: string;
  side: ReviewDiffSide;
  commit?: string;
}

export type ReviewCanvasContent =
  | { kind: "loading" }
  | {
      kind: "api";
      softwareMapEnabled?: boolean;
      reviewId: string;
      version?: number;
      bridge: ReviewCanvasBridge;
      setTitle?(title: string): void;
      setVersion?(version: number): void;
      openSource?(
        source: ReviewApiSourceLocation,
        range: ReviewInlineEditorRange,
      ): Promise<void>;
    }
  | {
      kind: "error";
      message: string;
      reviewErrors?: readonly ReviewListError[];
    }
  // The Source tab: an empty state beside the read-only file tree. Static —
  // the tree and the file tabs it opens are native surfaces. `error` is set
  // when the worktree cannot be browsed (deleted checkout, unavailable
  // session) and carries the human-readable reason.
  | { kind: "source"; error?: string }
  | {
      kind: "home";
      reviews: readonly ReviewHomeItem[];
      reviewErrors: readonly ReviewListError[];
      openReview(uuid: string): void;
      // Deletes the review and closes its canvas. Absent when the host does
      // not support deletion.
      deleteReview?(uuid: string): Promise<void>;
      // Dismissal is reversible: it stamps the review and starts the reap
      // clock. Deletion is immediate and permanent. Absent when the host does
      // not support them.
      dismissReview?(uuid: string): Promise<void>;
      restoreReview?(uuid: string): Promise<void>;
      // Opens the review and pins its read-only source tree open. Absent when
      // the host cannot show the tree.
      openSourceTree?(uuid: string): void;
      // Absent when the install status endpoint is unavailable.
      setup?: ReviewCanvasHomeSetup;
      // With no reviews, Home renders the Welcome rail instead of a zero
      // state of its own, so it needs what Welcome needs. Both absent when
      // the install status endpoint is unavailable.
      install?: ReviewCanvasInstallContent;
      onboarding?: ReviewCanvasOnboarding;
      // Opens the tutorial tab. Never gated on install status: the tutorial
      // needs no agent.
      openTutorial(): void;
    }
  | {
      kind: "welcome";
      // Absent when the install status endpoint is unavailable.
      install?: ReviewCanvasInstallContent;
      // Closes the Welcome tab ("Skip for now" on first run).
      close?(): void;
      // Drives the step rail. Absent when the install status is unavailable.
      onboarding?: ReviewCanvasOnboarding;
      // Opens the tutorial tab. Never gated on install status: the tutorial
      // needs no agent.
      openTutorial(): void;
    }
  | {
      kind: "settings";
      settings: ReviewCanvasSettingsContent;
    }
  | {
      kind: "completed";
      reviewPath?: string;
      showHome(): void;
    }
  | {
      kind: "session";
      bridge: ReviewCanvasBridge;
      document: Promise<ReviewDocumentLoad>;
      softwareMap: Promise<ReviewSoftwareMapLoad | null>;
      softwareMapEnabled: boolean;
      reviewErrors: readonly ReviewListError[];
      range: ReviewCanvasRange;
      commits: readonly ReviewCommitSummary[];
      tutorial?: ReviewCanvasTutorialBridge;
    };

export interface ReviewCanvasRange {
  sourceUnavailable?: string;
  baseRef: string;
  headRef: string;
  baseCommit: string;
  headCommit: string;
}

export interface ReviewCanvasHandle extends ReviewDisposable {
  update(content: ReviewCanvasContent): void;
  focus(): void;
  showFind(seed?: string): boolean;
}

export const REVIEW_CANVAS_RESUME_EVENT = "dev-fast-review-canvas-resume";

export interface ReviewCanvasModule {
  mountReviewCanvas(
    container: HTMLElement,
    content: ReviewCanvasContent,
  ): ReviewCanvasHandle;
}

// Tolerant of unknown keys so future additive fields never force a version
// bump; readers must ignore fields they do not understand.
export const ReviewDesktopDiscoverySchema = z.object({
  version: z.literal(REVIEW_DESKTOP_DISCOVERY_VERSION, {
    error: "Unsupported Review Desktop discovery version",
  }),
  instanceId: requiredString,
  url: loopbackOriginSchema,
  appPid: positiveInteger,
  serverPid: positiveInteger,
  token: requiredString,
  startedAt: positiveInteger,
  cliPath: requiredString.optional(),
  cliVersion: requiredString.optional(),
  // An executable that behaves as Node.js when ELECTRON_RUN_AS_NODE=1 is set
  // (the app's Electron binary). Consumers run cliPath with it so the CLI
  // uses the exact runtime the app ships instead of whatever `node` is on
  // PATH.
  cliRuntimePath: requiredString.optional(),
});

export type ReviewDesktopDiscovery = z.infer<
  typeof ReviewDesktopDiscoverySchema
>;

export const ReviewRepositoryIdentitySchema = z.strictObject({
  kind: z.enum(["git", "jj", "none"], {
    error: "must be git, jj, or none",
  }),
  repositoryId: requiredString,
  repositoryPath: requiredString,
  worktreeRoot: requiredString,
});

export type ReviewRepositoryIdentity = z.infer<
  typeof ReviewRepositoryIdentitySchema
>;

export type ReviewRepositoryKind = ReviewRepositoryIdentity["kind"];

export const ReviewStatusSchema = z.enum([
  "draft",
  "awaiting-review",
  "awaiting-agent-updates",
  "accepted",
  "rejected",
]);

export const ReviewSourceIdentitySchema = z.strictObject({
  kind: z.enum(["git-branch", "git-commit", "jj-bookmark", "jj-change"]),
  name: requiredString,
});

export type ReviewSourceIdentity = z.infer<typeof ReviewSourceIdentitySchema>;

export const ReviewAgentSessionRoleSchema = z.enum([
  "author",
  "map-worker",
  "publisher",
  "updater",
  "question",
]);

export type ReviewAgentSessionRole = z.infer<
  typeof ReviewAgentSessionRoleSchema
>;

export const ReviewAgentSessionAttributionSchema = z.strictObject({
  roles: z.array(ReviewAgentSessionRoleSchema),
  firstSeenAt: requiredString,
  lastSeenAt: requiredString,
});

export type ReviewAgentSessionAttribution = z.infer<
  typeof ReviewAgentSessionAttributionSchema
>;

export const ReviewRecordSchema = z.strictObject({
  schemaVersion: z.literal(REVIEW_SCHEMA_VERSION),
  uuid: z.uuid({ error: "must be a UUID" }),
  /* System Reviews use the complete stored-Review/session pipeline without
     appearing in user-facing Review lists. Absence preserves the historical
     user-visible default. */
  visibility: z.literal("system").optional(),
  repoKey: requiredString,
  worktreePath: requiredString,
  baseRef: requiredString,
  baseCommit: requiredString,
  sourceCommit: requiredString.nullable(),
  sourceIdentity: ReviewSourceIdentitySchema.nullable(),
  pullRequestNumber: positiveInteger.nullable().optional(),
  pullRequestUrl: absoluteUrlSchema.nullable().optional(),
  title: stringAllowEmpty,
  sourceSession: requiredString,
  agentSessions: z
    .record(requiredString, ReviewAgentSessionAttributionSchema)
    .optional(),
  status: ReviewStatusSchema,
  presentedDocumentRevision: requiredString.nullable(),
  presentedSoftwareMapRevision: requiredString.nullable(),
  createdAt: requiredString,
  lastPublishedAt: requiredString.nullable(),
  /* The attention axis, separate from status: status tracks the agent handoff,
     these track the reader. Both stay optional so a review.json written before
     this field existed still parses and needs no migration. */
  viewedAt: requiredString.nullable().optional(),
  dismissedAt: requiredString.nullable().optional(),
});

export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;

export const ReviewCommitSummarySchema = z.strictObject({
  commit: z
    .string({ error: "must be a 40-hex revision" })
    .regex(/^[0-9a-f]{40}$/i, "must be a 40-hex revision"),
  parentCommit: z
    .string({ error: "must be a 40-hex revision" })
    .regex(/^[0-9a-f]{40}$/i, "must be a 40-hex revision"),
  subject: stringAllowEmpty,
  author: stringAllowEmpty,
  authoredAt: requiredString,
  fileCount: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

export type ReviewCommitSummary = z.infer<typeof ReviewCommitSummarySchema>;

export const ReviewDescriptorSchema = z.strictObject({
  sourceUnavailable: requiredString.optional(),
  uuid: z.uuid({ error: "must be a UUID" }),
  title: stringAllowEmpty,
  status: z.enum([
    "draft",
    "awaiting-review",
    "awaiting-agent-updates",
    "accepted",
    "rejected",
  ]),
  worktreePath: requiredString,
  repoKey: requiredString,
  sourceBranch: requiredString.nullable(),
  baseRef: requiredString.optional(),
  headRef: requiredString.optional(),
  commits: z.array(ReviewCommitSummarySchema).optional(),
  pullRequestNumber: positiveInteger.nullable().optional(),
  pullRequestUrl: absoluteUrlSchema.nullable().optional(),
  diffStats: z
    .strictObject({
      fileCount: nonNegativeInteger,
      additions: nonNegativeInteger,
      deletions: nonNegativeInteger,
    })
    .nullable()
    .optional(),
  documentUpdatedAt: requiredString.nullable().optional(),
  presentedDocumentRevision: requiredString.nullable(),
  presentedSoftwareMapRevision: requiredString.nullable(),
  lastPublishedAt: requiredString.nullable(),
  available: z.boolean(),
  viewedAt: requiredString.nullable().optional(),
  dismissedAt: requiredString.nullable().optional(),
  /* Absolute deadline, so Home can count down without knowing the retention
     setting. Null when retention is off or the review is not dismissed. */
  reapsAt: requiredString.nullable().optional(),
});

export type ReviewDescriptor = z.infer<typeof ReviewDescriptorSchema>;

/** Home needs display metadata, not a client-accessible checkout path. */
export type ReviewHomeItem = Omit<
  ReviewDescriptor,
  "worktreePath" | "presentedSoftwareMapRevision"
> & {
  worktreePath?: string;
  repositoryLabel?: string;
};

export const ReviewSessionDescriptorSchema = z.strictObject({
  sessionId: requiredString,
  sessionUrl: loopbackUrlSchema,
  reviewUuid: z.uuid({ error: "must be a UUID" }),
  routePath: routePathSchema,
  startedAt: positiveInteger,
  sourceUnavailable: requiredString.optional(),
  historicalRevision: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
});

export type ReviewSessionDescriptor = z.infer<
  typeof ReviewSessionDescriptorSchema
>;

export const ReviewDocumentVersionSchema = z.strictObject({
  // Presentation identity: legacy Git revisions or API snapshot versions.
  revision: z.string().min(1),
  /** Unix milliseconds when the version was sealed. */
  sealedAt: positiveInteger,
  isCurrent: z.boolean(),
});

export type ReviewDocumentVersionWire = z.infer<
  typeof ReviewDocumentVersionSchema
>;

/** The native agent session that authored the review. */
export const AuthoringAgentSessionSchema = z.strictObject({
  harness: z.enum(["claude-code", "codex", "opencode", "pi"]),
  sessionId: requiredString,
});

export type AuthoringAgentSessionWire = z.infer<
  typeof AuthoringAgentSessionSchema
>;

// The two errors that carry more than a message. `mapStale` only means
// something for needs_republish, so it lives in that variant and nowhere else.
export const ReviewErrorDetailSchema = z.discriminatedUnion("code", [
  z.strictObject({
    code: z.literal("needs_republish"),
    reviewUuid: z.uuid({ error: "must be a UUID" }),
    mapStale: z.boolean(),
  }),
  z.strictObject({
    code: z.literal("historical_revision_unavailable"),
    reviewUuid: z.uuid({ error: "must be a UUID" }),
  }),
]);

export type ReviewErrorDetail = z.infer<typeof ReviewErrorDetailSchema>;

export const ReviewErrorResponseSchema = z
  .strictObject({
    ok: z.literal(false),
    error: requiredString,
    /** Machine-readable code for errors that carry no structured detail. */
    code: requiredString.optional(),
    retryable: z.boolean().optional(),
    detail: ReviewErrorDetailSchema.optional(),
  })
  .refine((value) => value.code === undefined || value.detail === undefined, {
    path: ["detail"],
    message: "An error reports either a bare code or a structured detail",
  });

export type ReviewErrorResponse = z.infer<typeof ReviewErrorResponseSchema>;

export const ReviewOpenResponseSchema = z.strictObject({
  sessionId: requiredString,
  url: loopbackUrlSchema,
  session: ReviewSessionDescriptorSchema,
  review: ReviewDescriptorSchema,
});

export type ReviewOpenResponse = z.infer<typeof ReviewOpenResponseSchema>;

/* The tutorial Review is not in the review store, so `GET /reviews` never
   lists it. The open response carries its descriptor and live session so the
   app can open the tab without the Home list. */
export const ReviewTutorialOpenResponseSchema = z.strictObject({
  reviewUuid: z.uuid({ error: "must be a UUID" }),
  sessionId: requiredString,
  url: loopbackUrlSchema,
  review: ReviewDescriptorSchema,
  session: ReviewSessionDescriptorSchema,
});

export type ReviewTutorialOpenResponse = z.infer<
  typeof ReviewTutorialOpenResponseSchema
>;

export const ReviewListResponseSchema = z.strictObject({
  reviews: z.array(ReviewDescriptorSchema),
  errors: z.array(
    z.strictObject({
      reviewDir: requiredString,
      reviewUuid: z.uuid({ error: "must be a UUID" }).nullable(),
      title: stringAllowEmpty,
      worktreePath: requiredString,
      lastPublishedAt: requiredString.nullable(),
      message: requiredString,
      code: requiredString.optional(),
    }),
  ),
});

export type ReviewListResponse = z.infer<typeof ReviewListResponseSchema>;

export type ReviewListError = ReviewListResponse["errors"][number];

export const ReviewStackLayerSchema = z.strictObject({
  branch: requiredString,
  pullRequestNumber: positiveInteger,
  pullRequestUrl: absoluteUrlSchema.nullable(),
  reviewUuid: z.uuid({ error: "must be a UUID" }).nullable(),
  reviewTitle: stringAllowEmpty.nullable(),
  relation: z.enum(["earlier", "current", "later"]),
});

export type ReviewStackLayer = z.infer<typeof ReviewStackLayerSchema>;

export const ReviewStackResponseSchema = z.strictObject({
  layers: z.array(ReviewStackLayerSchema),
});

export type ReviewStackResponse = z.infer<typeof ReviewStackResponseSchema>;

export const ReviewCliInstallTargetSchema = z.enum(
  ["claude", "codex", "cursor", "opencode", "pi"],
  { error: "must be claude, codex, cursor, opencode, or pi" },
);

export type ReviewCliInstallTarget = z.infer<
  typeof ReviewCliInstallTargetSchema
>;

export const ReviewFffInstallTargetSchema = z.enum(["claude", "codex", "pi"], {
  error: "must be claude, codex, or pi",
});

export type ReviewFffInstallTarget = z.infer<
  typeof ReviewFffInstallTargetSchema
>;

export const ReviewFffManagedRegistrationSchema = z.strictObject({
  target: ReviewFffInstallTargetSchema,
  command: requiredString,
  args: z.array(requiredString),
});

export type ReviewFffManagedRegistration = z.infer<
  typeof ReviewFffManagedRegistrationSchema
>;

export const ReviewMcpRegistrationSchema = z.strictObject({
  target: z.enum(["codex", "claude"]),
  configPath: requiredString,
  command: requiredString,
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
});

export type ReviewMcpRegistration = z.infer<typeof ReviewMcpRegistrationSchema>;

export const ReviewCliInstallStampSchema = z.strictObject({
  consent: z.enum(["granted", "declined", "skipped"], {
    error: "must be granted, declined, or skipped",
  }),
  fingerprint: requiredString.optional(),
  targets: z.array(ReviewCliInstallTargetSchema).optional(),
  shimPath: requiredString.optional(),
  fffRegistrations: z.array(ReviewFffManagedRegistrationSchema).optional(),
  mcpRegistrations: z.array(ReviewMcpRegistrationSchema).optional(),
  traceManaged: z.boolean().optional(),
  updatedAt: requiredString,
});

export type ReviewCliInstallStamp = z.infer<typeof ReviewCliInstallStampSchema>;

export const ReviewCliInstallStatusSchema = z.strictObject({
  agents: z.array(
    z.strictObject({
      target: ReviewCliInstallTargetSchema,
      present: z.boolean(),
      installed: z.boolean(),
    }),
  ),
  fingerprint: requiredString,
  stamp: ReviewCliInstallStampSchema.nullable(),
  stale: z.boolean(),
  skills: z
    .array(
      z.strictObject({
        target: ReviewCliInstallTargetSchema,
        name: requiredString,
        installedVersion: requiredString.nullable(),
        bundledVersion: requiredString.nullable(),
        stale: z.boolean(),
        error: requiredString.optional(),
      }),
    )
    .optional(),
  error: requiredString.optional(),
  mcp: z
    .array(
      z.strictObject({
        target: z.enum(["codex", "claude"]),
        state: z.enum(["ready", "missing", "custom", "error"]),
        error: requiredString.optional(),
      }),
    )
    .optional(),
  shim: z.strictObject({
    path: requiredString,
    installed: z.boolean(),
    profileConfigured: z.boolean(),
    onPath: z.boolean(),
  }),
  fff: z.strictObject({
    serverName: z.literal("fff"),
    corpusRoot: requiredString,
    binary: z.strictObject({ path: requiredString, installed: z.boolean() }),
    registrations: z.array(
      z.strictObject({
        target: ReviewFffInstallTargetSchema,
        present: z.boolean(),
        managed: z.boolean(),
      }),
    ),
  }),
  trace: z.strictObject({
    enabled: z.boolean(),
    configured: z.boolean(),
    autoActivateRepositories: z.boolean(),
    envPath: requiredString,
    settingsPath: requiredString,
    endpoint: requiredString.optional(),
    bucket: requiredString.optional(),
    region: requiredString.optional(),
    accessKeyIdPrefix: requiredString.optional(),
    verifiedAt: requiredString.optional(),
    error: requiredString.optional(),
    // Trace storage selection (version-2 config); absent from older CLIs.
    configPath: requiredString.optional(),
    storageMode: z.enum(["s3", "hosted", "none"]).optional(),
    credentialsSource: z
      .enum(["profile", "legacy-file", "process-env", "none"])
      .optional(),
    captureSource: z.enum(["profile", "settings"]).optional(),
  }),
  // Null when the serving package has no built CLI (a source-run dev server).
  cli: z
    .strictObject({ path: requiredString, version: requiredString })
    .nullable(),
});

export type ReviewCliInstallStatus = z.infer<
  typeof ReviewCliInstallStatusSchema
>;

// Skills and FFF integrations are per-agent. Skill requests install the review
// command by default. The command, FFF binary, and trace configuration are
// per-machine. Silent app updates omit `fff` and `trace`, so they do not run an
// FFF installer or contact R2.
export const ReviewCliInstallApplyRequestSchema = z
  .strictObject({
    targets: z.array(ReviewCliInstallTargetSchema),
    shim: z.boolean().optional(),
    autoUpdate: z.boolean().optional(),
    fff: z.boolean().optional(),
    trace: z
      .union([
        z.literal(true),
        z.strictObject({
          endpoint: requiredString.optional(),
          bucket: requiredString.optional(),
          key: requiredString.optional(),
          secret: requiredString.optional(),
          region: requiredString.optional(),
        }),
      ])
      .optional(),
  })
  .refine(
    (request) =>
      request.targets.length > 0 ||
      request.shim === true ||
      request.fff === true ||
      request.trace !== undefined,
    { message: "must install skills, the command, FFF, or trace capture" },
  );

export type ReviewCliInstallApplyRequest = z.infer<
  typeof ReviewCliInstallApplyRequestSchema
>;

export const ReviewCliInstallApplyResponseSchema = z.strictObject({
  ok: z.boolean(),
  output: stringAllowEmpty,
  shimPath: requiredString.optional(),
});

export type ReviewCliInstallApplyResponse = z.infer<
  typeof ReviewCliInstallApplyResponseSchema
>;

export const ReviewSessionLifecycleEventSchema = z.discriminatedUnion("event", [
  z.strictObject({ event: z.literal("ready"), sessionId: requiredString }),
  z.strictObject({
    event: z.literal("dismissed"),
    sessionId: requiredString,
    reason: z.enum(["closed", "replaced", "app-exit"]),
  }),
  z.strictObject({
    event: z.literal("error"),
    sessionId: requiredString,
    error: requiredString,
  }),
]);

export type ReviewSessionLifecycleEvent = z.infer<
  typeof ReviewSessionLifecycleEventSchema
>;

export const ReviewDesktopGlobalEventSchema = z.discriminatedUnion("event", [
  z.strictObject({
    event: z.literal("session-registered"),
    session: ReviewSessionDescriptorSchema,
    /* Publish carries the newly authoritative Home row. Ordinary session
       opens omit it because Home already has the published descriptor. */
    review: ReviewDescriptorSchema.optional(),
    // True when the session was opened for a non-document surface (the
    // Source tab rooting its file tree): the app must not surface the
    // review document tab for it. Absent means foreground.
    background: z.boolean().optional(),
  }),
  z.strictObject({
    event: z.literal("session-updated"),
    session: ReviewSessionDescriptorSchema,
  }),
  z.strictObject({
    event: z.literal("review-data-changed"),
    uuid: z.uuid({ error: "must be a UUID" }),
    sessionId: requiredString,
  }),
  z.strictObject({
    event: z.literal("session-closed"),
    sessionId: requiredString,
    reason: requiredString,
  }),
  z.strictObject({
    event: z.literal("review-status-changed"),
    uuid: z.uuid({ error: "must be a UUID" }),
    status: ReviewStatusSchema,
  }),
  z.strictObject({
    event: z.literal("review-deleted"),
    uuid: z.uuid({ error: "must be a UUID" }),
  }),
  /* Dismissal is the reader's terminal action. */
  z.strictObject({
    event: z.literal("review-attention-changed"),
    uuid: z.uuid({ error: "must be a UUID" }),
    attention: z.enum(["new", "viewed", "dismissed"]),
    viewedAt: requiredString.nullable(),
    dismissedAt: requiredString.nullable(),
    reapsAt: requiredString.nullable(),
  }),
  z.strictObject({
    event: z.literal("preferences-changed"),
    preferences: z.strictObject({
      dismissedRetentionDays: positiveInteger.nullable(),
    }),
  }),
]);

export type ReviewDesktopGlobalEvent = z.infer<
  typeof ReviewDesktopGlobalEventSchema
>;

export const ReviewSessionSchema = z.strictObject({
  sessionId: requiredString.optional(),
  rootPath: requiredString,
  baseRootPath: requiredString.optional(),
  headRootPath: requiredString.optional(),
  baseRef: requiredString,
  headRef: requiredString.optional(),
  pullRequestNumber: positiveInteger.optional(),
  pullRequestUrl: absoluteUrlSchema.optional(),
  routePath: routePathSchema.optional(),
  appUrl: absoluteUrlSchema,
  appPort: positiveInteger.optional(),
  serverUrl: urlSchema("origin").optional(),
  sessionUrl: loopbackUrlSchema.optional(),
  storageDir: requiredString.optional(),
  reviewPath: requiredString,
  codeGraphUrl: absoluteUrlSchema.optional(),
  agent: AuthoringAgentSessionSchema.optional(),
  resolvedBaseRef: requiredString.nullable().optional(),
  reviewStatus: ReviewStatusSchema.optional(),
  historicalRevision: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  startedAt: positiveInteger,
});

export type ReviewSessionWire = z.infer<typeof ReviewSessionSchema>;

export const ReviewDiffFileSchema = z.strictObject({
  path: requiredString,
  previousPath: requiredString.optional(),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  additions: nonNegativeInteger,
  deletions: nonNegativeInteger,
  patch: requiredString.optional(),
});

export type ReviewDiffFileWire = z.infer<typeof ReviewDiffFileSchema>;

export interface ReviewDiffStats {
  readonly fileCount: number;
  readonly additions: number;
  readonly deletions: number;
}

export function summarizeReviewDiffFiles(
  files: readonly {
    readonly additions?: number;
    readonly deletions?: number;
  }[],
): ReviewDiffStats {
  return files.reduce<ReviewDiffStats>(
    (total, file) => ({
      fileCount: total.fileCount + 1,
      additions: total.additions + (file.additions ?? 0),
      deletions: total.deletions + (file.deletions ?? 0),
    }),
    { fileCount: 0, additions: 0, deletions: 0 },
  );
}

export const ReviewDiffFilesRequestSchema = z.strictObject({
  includePatch: z.boolean().optional(),
  paths: z.array(z.string()).optional(),
  commit: z
    .string({ error: "must be a 40-hex revision" })
    .regex(/^[0-9a-f]{40}$/i, "must be a 40-hex revision")
    .optional(),
});

export type ReviewDiffFilesRequest = z.infer<
  typeof ReviewDiffFilesRequestSchema
>;

export const ReviewDiffFilesResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    baseRef: requiredString.optional(),
    headRef: requiredString.optional(),
    files: z.array(ReviewDiffFileSchema),
  }),
  ReviewErrorResponseSchema,
]);

export type ReviewDiffFilesResponse = z.infer<
  typeof ReviewDiffFilesResponseSchema
>;

export const ReviewFileContentRequestSchema = z.strictObject({
  path: requiredString,
  side: reviewDiffSideSchema,
  commit: z
    .string({ error: "must be a 40-hex revision" })
    .regex(/^[0-9a-f]{40}$/i, "must be a 40-hex revision")
    .optional(),
});

export type ReviewFileContentRequest = z.infer<
  typeof ReviewFileContentRequestSchema
>;

export const ReviewFileContentResponseSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    content: stringAllowEmpty,
    truncated: z.boolean().optional(),
  }),
  z.strictObject({ ok: z.literal(true), absent: z.literal(true) }),
  z.strictObject({ ok: z.literal(true), binary: z.literal(true) }),
  ReviewErrorResponseSchema,
]);

export type ReviewFileContentResponse = z.infer<
  typeof ReviewFileContentResponseSchema
>;

export const ReviewSessionResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    session: ReviewSessionSchema,
    token: requiredString,
  }),
  ReviewErrorResponseSchema,
]);

export type ReviewSessionResponse = z.infer<typeof ReviewSessionResponseSchema>;

export const ReviewDocumentResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    contentHash: requiredString,
    documentUrl: absoluteUrlSchema,
  }),
  ReviewErrorResponseSchema,
]);

export type ReviewDocumentResponse = z.infer<
  typeof ReviewDocumentResponseSchema
>;

export const ReviewSoftwareMapResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    contentHash: requiredString,
    headMapUrl: absoluteUrlSchema,
    baseMapUrl: absoluteUrlSchema,
  }),
  ReviewErrorResponseSchema,
]);

export type ReviewSoftwareMapResponse = z.infer<
  typeof ReviewSoftwareMapResponseSchema
>;

export const ReviewServerEventSchema = z.discriminatedUnion("event", [
  z.strictObject({
    event: z.literal("session-updated"),
    session: ReviewSessionSchema,
  }),
]);

export type ReviewServerEvent = z.infer<typeof ReviewServerEventSchema>;

export const ReviewRangeSchema = z
  .strictObject({
    fromLine: positiveInteger,
    toLine: positiveInteger,
  })
  .superRefine((range, context) => {
    if (range.toLine < range.fromLine) {
      context.addIssue({
        code: "custom",
        message: "must be >= fromLine",
        path: ["toLine"],
      });
    }
  });

export type ReviewRangeWire = z.infer<typeof ReviewRangeSchema>;

export const ReviewOpenEditorSchema = z.strictObject({
  path: requiredString,
  scheme: requiredString,
});

export type ReviewOpenEditorWire = z.infer<typeof ReviewOpenEditorSchema>;

export const ReviewEditorSelectionSchema = z.strictObject({
  path: requiredString,
  startLine: positiveInteger,
  startColumn: positiveInteger,
  endLine: positiveInteger,
  endColumn: positiveInteger,
});

export type ReviewEditorSelectionWire = z.infer<
  typeof ReviewEditorSelectionSchema
>;

export const ReviewDesktopStateSchema = z.strictObject({
  openEditors: z.array(ReviewOpenEditorSchema),
  activeEditor: ReviewOpenEditorSchema.nullable(),
  selection: ReviewEditorSelectionSchema.nullable(),
});

export type ReviewDesktopState = z.infer<typeof ReviewDesktopStateSchema>;

const revealArgsSchema = z
  .strictObject({
    path: requiredString,
    startLine: positiveInteger,
    endLine: positiveInteger,
    side: reviewDiffSideSchema.optional(),
    highlight: z.boolean().optional(),
    preserveFocus: z.boolean().optional(),
  })
  .superRefine((args, context) => {
    if (args.endLine < args.startLine) {
      context.addIssue({
        code: "custom",
        message: "must be >= args.startLine",
        path: ["endLine"],
      });
    }
  });

export const REVIEW_DISCORD_URL = "https://discord.gg/wYvd2cpMQg";

export const ReviewVerbRequestSchema = z.discriminatedUnion("name", [
  z.strictObject({ name: z.literal("joinDiscord"), args: z.strictObject({}) }),
  z.strictObject({
    name: z.literal("showReviewView"),
    args: z.strictObject({ view: reviewViewSchema }),
  }),
  z.strictObject({
    name: z.literal("openSourceTree"),
    args: z.strictObject({}),
  }),
  z.strictObject({
    name: z.literal("openDiff"),
    args: z.strictObject({
      path: requiredString,
      previousPath: requiredString.optional(),
    }),
  }),
  z.strictObject({ name: z.literal("reveal"), args: revealArgsSchema }),
  z.strictObject({ name: z.literal("focusCanvas"), args: z.strictObject({}) }),
  z.strictObject({ name: z.literal("focusWindow"), args: z.strictObject({}) }),
  z.strictObject({
    name: z.literal("captureScreenshot"),
    args: z.strictObject({}),
  }),
  z.strictObject({
    name: z.literal("openReviewRevision"),
    args: z.strictObject({
      revision: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .optional(),
      sealedAt: positiveInteger.optional(),
    }),
  }),
  z.strictObject({
    name: z.literal("openReview"),
    args: z.strictObject({
      reviewUuid: z.uuid({ error: "must be a UUID" }),
      active: z.boolean(),
    }),
  }),
  z.strictObject({
    name: z.literal("openApiReview"),
    args: z.strictObject({ reviewId: z.uuid(), title: requiredString }),
  }),
]);

export type ReviewVerbRequest = z.infer<typeof ReviewVerbRequestSchema>;

export const ReviewVerbResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), result: z.unknown().optional() }),
  ReviewErrorResponseSchema,
]);

export type ReviewVerbResponse = z.infer<typeof ReviewVerbResponseSchema>;

export const ReviewDesktopVerbFrameSchema = z.strictObject({
  event: z.literal("desktop-verb"),
  id: requiredString,
  sessionId: requiredString,
  request: ReviewVerbRequestSchema,
});

export type ReviewDesktopVerbFrame = z.infer<
  typeof ReviewDesktopVerbFrameSchema
>;

export const ReviewDesktopVerbResultSchema = z.strictObject({
  id: requiredString,
  sessionId: requiredString,
  response: ReviewVerbResponseSchema,
});

export type ReviewDesktopVerbResult = z.infer<
  typeof ReviewDesktopVerbResultSchema
>;

export const ReviewSelectedDiffSchema = z.strictObject({
  oldPath: z.string(),
  newPath: z.string(),
  oldStart: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  rows: z.array(
    z.strictObject({
      kind: z.enum(["unchanged", "added", "deleted"]),
      text: z.string(),
    }),
  ),
});

export const ReviewSurfaceEventSchema = z.discriminatedUnion("event", [
  z.strictObject({
    event: z.literal("editorSelectionChanged"),
    anchor: z.object({ x: z.number(), y: z.number() }).optional(),
    path: requiredString,
    range: ReviewRangeSchema,
    sideContext: reviewDiffSideSchema,
    isEmpty: z.boolean(),
    selectedDiff: ReviewSelectedDiffSchema.optional(),
  }),
  z.strictObject({
    event: z.literal("themeChanged"),
    theme: reviewThemeSchema,
  }),
  z.strictObject({
    event: z.literal("showReviewView"),
    view: reviewViewSchema,
  }),
]);

export type ReviewSurfaceEvent = z.infer<typeof ReviewSurfaceEventSchema>;

// --- Agent trace view & trace quotes ----------------------------------------

export const ReviewTraceStorageKindSchema = z.enum(["s3", "hosted"]);

export type ReviewTraceStorageKind = z.infer<
  typeof ReviewTraceStorageKindSchema
>;

export const ReviewAgentTraceListResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    configured: z.boolean().default(true),
    // The store these sessions came from, and every store the machine can
    // read; absent from older CLIs.
    storage: z.enum(["s3", "hosted", "none"]).optional(),
    sources: z.array(ReviewTraceStorageKindSchema).optional(),
    // Why the selected store answered nothing: a refusal, a missing login
    // for a requested source, or a malformed config. Absent from older CLIs.
    storageError: requiredString.optional(),
    sessions: z.array(ReviewAgentTraceSessionSchema),
  }),
  ReviewErrorResponseSchema,
]);

export type ReviewAgentTraceListResponse = z.infer<
  typeof ReviewAgentTraceListResponseSchema
>;

export const ReviewAgentTraceResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    parserVersion: requiredString,
    session: ReviewAgentTraceSessionSchema,
    trace: stringAllowEmpty.nullable().optional(),
    // Whether the store confirmed this copy; absent from older CLIs.
    cacheStatus: z.enum(["current", "offline", "stale"]).optional(),
    subagents: z.array(requiredString).default([]),
    title: z.string().nullable(),
    startedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
    activeMs: z.number().nullable(),
    userTurns: z.number(),
    toolCalls: z.number(),
    events: z.array(ReviewAgentTraceEventSchema),
  }),
  ReviewErrorResponseSchema,
]);

export type ReviewAgentTraceResponse = z.infer<
  typeof ReviewAgentTraceResponseSchema
>;
