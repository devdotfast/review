import { type JsonObject, type JsonValue, isJsonObject } from "@dev.fast/json";
import {
  WhiteboardAgentTraceEventSchema,
  WhiteboardAgentTraceSessionSchema,
} from "@dev.fast/trace-protocol";
import { z } from "zod";

import type { SessionSummary } from "./whiteboard-api-client.js";

// Version 3: the desktop serves prebuilt revisions instead of building them.
// (Version 2 added the bundled-CLI discovery fields.)
export const WHITEBOARD_DESKTOP_DISCOVERY_VERSION = 3;

// Version 5: document and software-map bundles are JSON.
export const WHITEBOARD_SCHEMA_VERSION = 5;

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

const whiteboardDiffSideSchema = z.enum(["base", "head"], {
  error: "must be base or head",
});

export const whiteboardViewSchema = z.enum([
  "review",
  "commits",
  "diff",
  "map",
  "trace",
]);

export type WhiteboardView = z.infer<typeof whiteboardViewSchema>;

const whiteboardThemeSchema = z.enum(["light", "dark"], {
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

const loopbackOriginSchema = urlSchema("origin", (url) =>
  url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port
    ? null
    : "must use http://127.0.0.1:<port>",
);

export const WhiteboardRuntimeConfigSchema = z.strictObject({
  serverUrl: loopbackOriginSchema,
  sessionId: requiredString,
  token: stringAllowEmpty,
  wasmUrl: absoluteUrlSchema,
  appVersion: requiredString.max(100),
  theme: whiteboardThemeSchema,
  host: z.literal("desktop"),
});

export type WhiteboardRuntimeConfig = z.infer<
  typeof WhiteboardRuntimeConfigSchema
>;

export type WhiteboardHost = WhiteboardRuntimeConfig["host"];

export type WhiteboardTheme = WhiteboardRuntimeConfig["theme"];

export type WhiteboardDiffSide = z.infer<typeof whiteboardDiffSideSchema>;

/** How embedded diffs lay out: base and head side by side, or one column. */
export const WHITEBOARD_DIFF_LAYOUTS = ["split", "unified"] as const;

export type WhiteboardDiffLayout = (typeof WHITEBOARD_DIFF_LAYOUTS)[number];

export interface WhiteboardDisposable {
  dispose(): void;
}

export type WhiteboardInlineEditorHeightMode = "capped" | "content";

export interface WhiteboardInlineEditorRange {
  startLine: number;
  endLine: number;
  side?: WhiteboardDiffSide;
}

/** The repository and commits a source was read from, when it names them
 * itself instead of using the review's pins. */
export interface WhiteboardSourcePins {
  readonly repositoryId: string;
  readonly head: string;
  readonly base?: string;
}

export interface WhiteboardInlineEditorSpec {
  progress?: WhiteboardDiffProgress;
  container: HTMLElement;
  path: string;
  title: string;
  description?: string;
  side: WhiteboardDiffSide;
  /** Read at these pins instead of the review's. */
  pins?: WhiteboardSourcePins;
  ranges: readonly WhiteboardInlineEditorRange[];
  /** Original authored selections, before display ranges are merged. */
  countRanges?: readonly WhiteboardInlineEditorRange[];
  heightMode: WhiteboardInlineEditorHeightMode;
  active: boolean;
  onDidFocus?: () => void;
  onDidOpen?: () => void;
  onDidNavigate?: () => void;
  onDidShowHover?: () => void;
}

export interface WhiteboardFindQuery {
  text: string;
  matchCase: boolean;
  wholeWord: boolean;
  isRegex: boolean;
}

export interface WhiteboardInlineFindResult {
  matchCount: number;
}

export interface WhiteboardInlineFindSpec {
  path: string;
  side: WhiteboardDiffSide;
  pins?: WhiteboardSourcePins;
  ranges: readonly WhiteboardInlineEditorRange[];
}

export interface WhiteboardInlineEditorHandle extends WhiteboardDisposable {
  setProgress?(progress: WhiteboardDiffProgress): void;
  readonly height: number;
  setActive(active: boolean): void;
  setCollapsed(collapsed: boolean): void;
  onDidChangeHeight(listener: (height: number) => void): WhiteboardDisposable;
  onDidError(listener: (message: string) => void): WhiteboardDisposable;
  setFindQuery(query: WhiteboardFindQuery): Promise<WhiteboardInlineFindResult>;
  revealFindMatch(index: number): void;
  clearActiveFindMatch(): void;
  clearFind(): void;
}

export interface WhiteboardInlineEditorFactory {
  create(spec: WhiteboardInlineEditorSpec): WhiteboardInlineEditorHandle;
  find(
    spec: WhiteboardInlineFindSpec,
    query: WhiteboardFindQuery,
  ): Promise<WhiteboardInlineFindResult>;
}

/** A lens is scoped to one immutable saved review version. */
export interface WhiteboardDiffLens {
  /** Filter files while retaining ordinary diff context/folding within them. */
  wholeFiles?: boolean;
  id: string;
  title: string;
  sessionId: string;
  version: number;
  ranges: readonly {
    side: "base" | "head";
    file: string;
    fromLine: number;
    toLine: number;
  }[];
}

/** "folded": nothing left to read and nothing marked; diffr folds all of it by default. */
export type WhiteboardDiffProgressState =
  | "unread"
  | "partial"
  | "viewed"
  | "folded";

/** Reader progress is supplied independently of the immutable comparison. */
export interface WhiteboardDiffProgressFile {
  path: string;
  state: WhiteboardDiffProgressState;
  remaining: { additions: number; deletions: number };
  total: { additions: number; deletions: number };
  viewedRanges: WhiteboardDiffLens["ranges"];
  changedRanges: WhiteboardDiffLens["ranges"];
  unfoldRanges?: WhiteboardDiffLens["ranges"];
}

export interface WhiteboardDiffSection {
  files?: readonly WhiteboardDiffProgressFile[];
  id: string;
  label: string;
  sources: WhiteboardDiffLens["ranges"];
  state: WhiteboardDiffProgressState;
  total: { additions: number; deletions: number };
  remaining: { additions: number; deletions: number };
}

export interface WhiteboardDiffProgress {
  sections?: readonly WhiteboardDiffSection[];
  files: readonly WhiteboardDiffProgressFile[];
  /** Only present while applying a new viewed action, to reset affected fold overrides. */
  changedPaths?: readonly string[];
}

export interface WhiteboardDiffViewSpec {
  /** Embed the same diff renderer in the review document. */
  document?: {
    heightMode: WhiteboardInlineEditorHeightMode;
    onDidChangeHeight(height: number): void;
    onDidFocus?: () => void;
    onDidOpen?: () => void;
  };
  container: HTMLElement;
  fileTreeContainer?: HTMLElement;
  progress?: WhiteboardDiffProgress;
  onToggleViewed?: (path: string, sectionId?: string) => void;
  onToggleSection?: (id: string) => void;
  lens?: WhiteboardDiffLens;
  scope?: WhiteboardCommitScope;
}

export interface WhiteboardDiffViewHandle extends WhiteboardDisposable {
  focus(): void;
  setProgress?(progress: WhiteboardDiffProgress): void;
  revealSource?(
    source: WhiteboardDiffLens["ranges"][number],
    sectionId?: string,
  ): void;
  onDidError(listener: (message: string) => void): WhiteboardDisposable;
  /** Fires when the diff scrolls or its topmost file changes. */
  onDidScroll?(
    listener: (viewport: WhiteboardDiffViewport) => void,
  ): WhiteboardDisposable;
  /**
   * Where `source` sits relative to the diff's reading line (its top edge),
   * in pixels; negative once it has scrolled past. Exact for files that are
   * rendered, ordered by file for the rest. Undefined when the file is not in
   * this diff.
   */
  sourceOffset?(
    source: WhiteboardDiffLens["ranges"][number],
  ): number | undefined;
}

export interface WhiteboardDiffViewport {
  height: number;
}

/**
 * Mounts the changed-files diff UI — file list and multi-diff widget — into an
 * app-owned container. `create` returns at once and initializes the widget
 * asynchronously; a failed initialization arrives through `onDidError`.
 */
export interface WhiteboardDiffViewFactory {
  create(spec: WhiteboardDiffViewSpec): WhiteboardDiffViewHandle;
  /** Returns the parsed full diff that backs the native diff view. */
  files(
    scope?: WhiteboardCommitScope,
  ): Promise<readonly WhiteboardDiffFileWire[]>;
}

export interface WhiteboardCommitScope {
  commit: string;
}

export interface WhiteboardCanvasDiagnostic {
  level: "error" | "warning";
  source: string;
  message: string;
  stack?: string;
}

export interface WhiteboardCanvasBridge {
  readonly appSessionId?: string;
  readonly config: WhiteboardRuntimeConfig;
  readonly inlineEditors: WhiteboardInlineEditorFactory;
  readonly diffView: WhiteboardDiffViewFactory;
  request(url: string, init?: RequestInit): Promise<Response>;
  post(request: WhiteboardVerbRequest): Promise<WhiteboardVerbResponse>;
  subscribe(
    listener: (event: WhiteboardSurfaceEvent) => void,
  ): WhiteboardDisposable;
  currentTheme(): WhiteboardTheme;
  onDidChangeTheme(
    listener: (theme: WhiteboardTheme) => void,
  ): WhiteboardDisposable;
  // The diff layout is app-wide and backed by the `diffEditor.renderSideBySide`
  // setting, so a choice outlives the session and the app restart.
  currentDiffLayout(): WhiteboardDiffLayout;
  setDiffLayout(layout: WhiteboardDiffLayout): Promise<void>;
  onDidChangeDiffLayout(
    listener: (layout: WhiteboardDiffLayout) => void,
  ): WhiteboardDisposable;
  notify?(message: { kind: "success" | "error"; text: string }): void;
  setupTooltip?(target: HTMLElement, text: string): WhiteboardDisposable;
  ready(): void;
  reportDiagnostic?(diagnostic: WhiteboardCanvasDiagnostic): void;
}

export interface WhiteboardCanvasSetupActions {
  load(): Promise<WhiteboardCanvasInstallContent>;
  installCli(): Promise<void>;
}

/**
 * Install state and actions the workbench hands to the Home canvas. `apply`,
 * `skip`, and `enablePrompts` resolve with the refreshed status so the card can
 * re-render without a full canvas update.
 */
export interface WhiteboardCanvasInstallContent {
  status: WhiteboardCliInstallStatus;
  apply(request: {
    targets: readonly WhiteboardCliInstallTarget[];
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
  }): Promise<WhiteboardCliInstallStatus>;
  remove(request: {
    targets: readonly WhiteboardCliInstallTarget[];
    shim?: boolean;
    fff?: boolean;
    trace?: true;
  }): Promise<WhiteboardCliInstallStatus>;
  decline(): Promise<WhiteboardCliInstallStatus>;
  skip(): Promise<WhiteboardCliInstallStatus>;
  enablePrompts(): Promise<WhiteboardCliInstallStatus>;
}

/**
 * Install status handed to the Home canvas so it can show a one-line setup
 * banner when the install needs attention. `open` navigates to the Agent
 * Setup page.
 */
export interface WhiteboardCanvasHomeSetup {
  status: WhiteboardCliInstallStatus;
  open(): void;
}

/**
 * Onboarding progress for the Welcome pane: which of the three steps the user
 * finished. `tutorialChecked` counts the checklist steps the tutorial
 * recorded, out of `tutorialTotal`.
 */
export interface WhiteboardCanvasOnboarding {
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
export const WHITEBOARD_THEME_CHOICES = ["dark", "light", "system"] as const;

export type WhiteboardThemeChoice = (typeof WHITEBOARD_THEME_CHOICES)[number];

export const WHITEBOARD_KEYMAP_CHOICES = ["none", "vim", "emacs"] as const;

export type WhiteboardKeymapChoice = (typeof WHITEBOARD_KEYMAP_CHOICES)[number];

export const WHITEBOARD_TUTORIAL_STEP_IDS = [
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

export type TutorialStepId = (typeof WHITEBOARD_TUTORIAL_STEP_IDS)[number];

export const WHITEBOARD_TUTORIAL_PROGRESS_STORAGE_KEY =
  "review.tutorial.progress.v1";

export interface TutorialProgressV1 {
  version: 1;
  checked: TutorialStepId[];
  dismissed: boolean;
}

export interface WhiteboardCanvasTutorialContent {
  sessionId: string;
  progress: TutorialProgressV1;
  keymap: WhiteboardKeymapChoice;
}

export interface WhiteboardCanvasTutorialBridge {
  content: WhiteboardCanvasTutorialContent;
  setStep(step: TutorialStepId, checked: boolean): void;
  dismiss(): void;
  reopen(): void;
  selectKeymap(keymap: WhiteboardKeymapChoice): Promise<void>;
  // Closes the managed tutorial tab without dismissing it from a user catalog.
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
export interface WhiteboardDiffrConfig {
  values: JsonObject;
  credentialSource: "config" | "environment" | "missing";
  changed?: boolean;
  error?: string;
}

export const whiteboardDiffrSummarizerInputSchema = z.object({
  enabled: z.boolean(),
  model: z.string().trim().min(1),
  tests: z.boolean(),
  apiKey: z.string().optional(),
});

export type WhiteboardDiffrSummarizerInput = z.infer<
  typeof whiteboardDiffrSummarizerInputSchema
>;

const whiteboardDiffrConfigSchema = z.object({
  values: z.custom<JsonObject>(isJsonObject),
  credentialSource: z.enum(["config", "environment", "missing"]),
  changed: z.boolean().optional(),
  error: z.string().optional(),
});

export function parseWhiteboardDiffrConfig(
  value: JsonValue,
): WhiteboardDiffrConfig {
  const result = whiteboardDiffrConfigSchema.safeParse(value);

  if (!result.success)
    throw new Error("diffr configuration response is malformed.");

  return result.data;
}

export interface WhiteboardDiffrConfigActions {
  read(): Promise<WhiteboardDiffrConfig>;
  set(key: string, value: JsonValue): Promise<WhiteboardDiffrConfig>;
  saveSummarizer(
    input: WhiteboardDiffrSummarizerInput,
  ): Promise<WhiteboardDiffrConfig>;
  testSummarizer(input: WhiteboardDiffrSummarizerInput): Promise<string>;
}

export interface WhiteboardCanvasSettingsContent {
  // Backed by the `whiteboard.telemetry.enabled` workbench setting, which the
  // review server and the CLI both read.
  telemetryEnabled: boolean;
  setTelemetryEnabled(enabled: boolean): Promise<boolean>;
  theme: WhiteboardThemeChoice;
  setTheme(choice: WhiteboardThemeChoice): Promise<WhiteboardThemeChoice>;
  keymap: WhiteboardKeymapChoice;
  // A keymap only takes effect after the extension host restarts, so the
  // workbench offers the window reload. The page never forces one.
  setKeymap(choice: WhiteboardKeymapChoice): Promise<WhiteboardKeymapChoice>;
  softwareMapEnabled: boolean;
  setSoftwareMapEnabled(enabled: boolean): Promise<boolean>;
  structuralDiffEnabled: boolean;
  setStructuralDiffEnabled(enabled: boolean): Promise<boolean>;
  // Not a workbench setting: the review server and `review install` both
  // read it, so it lives in the server preferences file. Off by default.
  // Turning it on makes the pad and installs its skill for set-up agents;
  // turning it off hides the pad and removes the skill.
  scratchpadEnabled: boolean;
  setScratchpadEnabled(enabled: boolean): Promise<boolean>;
  // Shared CLI configuration, read when its disclosure opens.
  diffrConfig: WhiteboardDiffrConfigActions;
  reloadWindow(): Promise<void>;
  manageExtensions(): void;
  // Agent installs are managed here too, so they stay reachable once Home
  // has reviews and no longer shows the Welcome rail. Absent when the
  // install status endpoint is unavailable.
  install?: WhiteboardCanvasInstallContent;
}

/** Workspace attachment identity is independent of the displayed source generation. */
export interface WhiteboardLanguageEnvironment {
  readonly rootPath: string | null;
  readonly identity: string;
  /** Present only when the language checkout is unavailable, not while preparing. */
  readonly issue?: string;
}

/** Authored version selection is independent of whether source is live or fixed. */
export type WhiteboardSourceSelection =
  | { readonly sessionId: string; readonly kind: "current" }
  | {
      readonly sessionId: string;
      readonly kind: "version";
      readonly version: number;
    };

export interface WhiteboardSourceView {
  readonly sessionId: string;
  readonly version: number;
  /** Cache invalidation for live files; does not select historical source. */
  readonly generation?: string;
  readonly commit?: string;
  /** Pins a reference names itself; the server reads there instead of the
   * review's pins, and `commit` does not apply. */
  readonly pins?: WhiteboardSourcePins;
}

export function resolveWhiteboardSourceView(snapshot: {
  sessionId: string;
  version: number;
  pins?: { worktreeRevision?: string };
}): WhiteboardSourceView {
  return Object.freeze({
    sessionId: snapshot.sessionId,
    version: snapshot.version,
    generation: snapshot.pins?.worktreeRevision,
  });
}

export function whiteboardSourceComparison(
  view: WhiteboardSourceView,
  commit?: string,
): WhiteboardSourceView {
  return commit
    ? Object.freeze({
        ...view,
        commit,
      })
    : view;
}

/** The view of one reference's own pins: the review's version, no commit
 * narrowing, and no live-file generation since the pins are commits. */
export function whiteboardSourceAnchor(
  view: WhiteboardSourceView,
  pins: WhiteboardSourcePins | undefined,
): WhiteboardSourceView {
  return pins
    ? Object.freeze({ sessionId: view.sessionId, version: view.version, pins })
    : view;
}

/** Existing HTTP parameters are an adapter, not the internal view model. */
export function whiteboardSourceQuery(view: WhiteboardSourceView) {
  return {
    version: view.version,
    commit: view.commit,
    repositoryId: view.pins?.repositoryId,
    base: view.pins?.base,
    head: view.pins?.head,
  };
}

/** Decode the pins of `reviewSourceQuery` from string parameters. */
export function whiteboardSourcePinsFromQuery(
  read: (key: string) => string | null | undefined,
): WhiteboardSourcePins | undefined {
  const repositoryId = read("repositoryId");
  const head = read("head");
  const base = read("base");

  if (!repositoryId || !head) return undefined;

  return Object.freeze(
    base ? { repositoryId, head, base } : { repositoryId, head },
  );
}

export interface WhiteboardApiSourceLocation {
  readonly view: WhiteboardSourceView;
  readonly file: string;
  readonly side: WhiteboardDiffSide;
}

export type WhiteboardCanvasContent =
  | { kind: "loading" }
  | {
      kind: "api";
      tutorial?: WhiteboardCanvasTutorialBridge;
      setTutorial?(enabled: boolean): void;
      structuralDiffEnabled?: boolean;
      softwareMapEnabled?: boolean;
      sessionId: string;
      version?: number;
      bridge: WhiteboardCanvasBridge;
      setTitle?(title: string): void;
      setSourceView?(
        selection: WhiteboardSourceSelection,
        view: WhiteboardSourceView,
      ): void;
      openSource?(
        source: WhiteboardApiSourceLocation,
        range: WhiteboardInlineEditorRange,
      ): Promise<void>;
    }
  | {
      kind: "error";
      message: string;
    }
  // The Source tab: an empty state beside the read-only file tree. Static —
  // the tree and the file tabs it opens are native surfaces. `error` is set
  // when the worktree cannot be browsed (deleted checkout, unavailable
  // session) and carries the human-readable reason.
  | { kind: "source"; error?: string }
  | {
      kind: "home";
      whiteboards: readonly SessionSummary[];
      openWhiteboard(uuid: string): void;
      // Deletes the review and closes its canvas. Absent when the host does
      // not support deletion.
      deleteWhiteboard?(uuid: string): Promise<void>;
      // Dismissal is reversible: it stamps the review and starts the reap
      // clock. Deletion is immediate and permanent. Absent when the host does
      // not support them.
      dismissWhiteboard?(uuid: string): Promise<void>;
      restoreWhiteboard?(uuid: string): Promise<void>;
      // Opens the review and pins its read-only source tree open. Absent when
      // the host cannot show the tree.
      openSourceTree?(uuid: string): void;
      // Absent when the install status endpoint is unavailable.
      setup?: WhiteboardCanvasHomeSetup;
      // With no reviews, Home renders the Welcome rail instead of a zero
      // state of its own, so it needs what Welcome needs. Both absent when
      // the install status endpoint is unavailable.
      install?: WhiteboardCanvasInstallContent;
      setupActions?: WhiteboardCanvasSetupActions;
      onboarding?: WhiteboardCanvasOnboarding;
      // Opens the tutorial tab. Never gated on install status: the tutorial
      // needs no agent.
      openTutorial(): void;
    }
  | {
      kind: "welcome";
      // Absent when the install status endpoint is unavailable.
      install?: WhiteboardCanvasInstallContent;
      setupActions?: WhiteboardCanvasSetupActions;
      // Closes the Welcome tab ("Skip for now" on first run).
      close?(): void;
      // Drives the step rail. Absent when the install status is unavailable.
      onboarding?: WhiteboardCanvasOnboarding;
      // Opens the tutorial tab. Never gated on install status: the tutorial
      // needs no agent.
      openTutorial(): void;
    }
  | {
      kind: "settings";
      settings: WhiteboardCanvasSettingsContent;
    };

export interface WhiteboardCanvasRange {
  sourceUnavailable?: string;
  baseRef: string;
  headRef: string;
  baseCommit: string;
  headCommit: string;
}

export interface WhiteboardCanvasHandle extends WhiteboardDisposable {
  update(content: WhiteboardCanvasContent): void;
  focus(): void;
  showFind(seed?: string): boolean;
}

export const WHITEBOARD_CANVAS_RESUME_EVENT =
  "dev-fast-whiteboard-canvas-resume";

export interface WhiteboardCanvasModule {
  mountWhiteboardCanvas(
    container: HTMLElement,
    content: WhiteboardCanvasContent,
  ): WhiteboardCanvasHandle;
}

// Tolerant of unknown keys so future additive fields never force a version
// bump; readers must ignore fields they do not understand.
export const WhiteboardDesktopDiscoverySchema = z.object({
  version: z.literal(WHITEBOARD_DESKTOP_DISCOVERY_VERSION, {
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

export type WhiteboardDesktopDiscovery = z.infer<
  typeof WhiteboardDesktopDiscoverySchema
>;

export const WhiteboardRepositoryIdentitySchema = z.strictObject({
  kind: z.enum(["git", "jj", "none"], {
    error: "must be git, jj, or none",
  }),
  repositoryId: requiredString,
  repositoryPath: requiredString,
  worktreeRoot: requiredString,
});

export type WhiteboardRepositoryIdentity = z.infer<
  typeof WhiteboardRepositoryIdentitySchema
>;

export type WhiteboardRepositoryKind = WhiteboardRepositoryIdentity["kind"];

export const WhiteboardStatusSchema = z.enum([
  "draft",
  "awaiting-review",
  "awaiting-agent-updates",
  "accepted",
  "rejected",
]);

export const WhiteboardSourceIdentitySchema = z.strictObject({
  kind: z.enum(["git-branch", "git-commit", "jj-bookmark", "jj-change"]),
  name: requiredString,
});

export type WhiteboardSourceIdentity = z.infer<
  typeof WhiteboardSourceIdentitySchema
>;

export const WhiteboardAgentSessionRoleSchema = z.enum([
  "author",
  "map-worker",
  "publisher",
  "updater",
  "question",
]);

export type WhiteboardAgentSessionRole = z.infer<
  typeof WhiteboardAgentSessionRoleSchema
>;

export const WhiteboardAgentSessionAttributionSchema = z.strictObject({
  roles: z.array(WhiteboardAgentSessionRoleSchema),
  firstSeenAt: requiredString,
  lastSeenAt: requiredString,
});

export type WhiteboardAgentSessionAttribution = z.infer<
  typeof WhiteboardAgentSessionAttributionSchema
>;

export const WhiteboardCommitSummarySchema = z.strictObject({
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

export type WhiteboardCommitSummary = z.infer<
  typeof WhiteboardCommitSummarySchema
>;

export const WhiteboardDocumentVersionSchema = z.strictObject({
  // The native snapshot version displayed by the canvas.
  revision: z.string().min(1),
  /** Unix milliseconds when the version was sealed. */
  sealedAt: positiveInteger,
  isCurrent: z.boolean(),
});

export type WhiteboardDocumentVersionWire = z.infer<
  typeof WhiteboardDocumentVersionSchema
>;

/** The native agent session that authored the review. */
export const AuthoringAgentSessionSchema = z.strictObject({
  harness: z.enum(["claude-code", "codex", "opencode", "pi"]),
  sessionId: requiredString,
});

export type AuthoringAgentSessionWire = z.infer<
  typeof AuthoringAgentSessionSchema
>;

export const WhiteboardErrorResponseSchema = z.strictObject({
  ok: z.literal(false),
  error: requiredString,
  code: requiredString.optional(),
  retryable: z.boolean().optional(),
});

export type WhiteboardErrorResponse = z.infer<
  typeof WhiteboardErrorResponseSchema
>;

/** Managed tutorials use the native JSON canvas and stay out of Home. */
export const WhiteboardTutorialOpenResponseSchema = z.strictObject({
  kind: z.literal("api"),
  sessionId: z.uuid({ error: "must be a UUID" }),
  title: stringAllowEmpty,
});

export type WhiteboardTutorialOpenResponse = z.infer<
  typeof WhiteboardTutorialOpenResponseSchema
>;

export const WhiteboardStackLayerSchema = z.strictObject({
  branch: requiredString,
  pullRequestNumber: positiveInteger,
  pullRequestUrl: absoluteUrlSchema.nullable(),
  sessionId: z.uuid({ error: "must be a UUID" }).nullable(),
  whiteboardTitle: stringAllowEmpty.nullable(),
  relation: z.enum(["earlier", "current", "later"]),
});

export type WhiteboardStackLayer = z.infer<typeof WhiteboardStackLayerSchema>;

export const WhiteboardStackResponseSchema = z.strictObject({
  layers: z.array(WhiteboardStackLayerSchema),
});

export type WhiteboardStackResponse = z.infer<
  typeof WhiteboardStackResponseSchema
>;

export const WhiteboardCliInstallTargetSchema = z.enum(
  ["claude", "codex", "cursor", "opencode", "pi"],
  { error: "must be claude, codex, cursor, opencode, or pi" },
);

export type WhiteboardCliInstallTarget = z.infer<
  typeof WhiteboardCliInstallTargetSchema
>;

export const WhiteboardFffInstallTargetSchema = z.enum(
  ["claude", "codex", "pi"],
  {
    error: "must be claude, codex, or pi",
  },
);

export type WhiteboardFffInstallTarget = z.infer<
  typeof WhiteboardFffInstallTargetSchema
>;

export const WhiteboardFffManagedRegistrationSchema = z.strictObject({
  target: WhiteboardFffInstallTargetSchema,
  command: requiredString,
  args: z.array(requiredString),
});

export type WhiteboardFffManagedRegistration = z.infer<
  typeof WhiteboardFffManagedRegistrationSchema
>;

export const WhiteboardMcpRegistrationSchema = z.strictObject({
  name: z.enum(["review", "whiteboard"]).optional(),
  target: z.enum(["codex", "claude", "cursor", "opencode"]),
  configPath: requiredString,
  command: requiredString,
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
});

export type WhiteboardMcpRegistration = z.infer<
  typeof WhiteboardMcpRegistrationSchema
>;

export const WhiteboardCliInstallStampSchema = z.strictObject({
  consent: z.enum(["granted", "declined", "skipped"], {
    error: "must be granted, declined, or skipped",
  }),
  fingerprint: requiredString.optional(),
  targets: z.array(WhiteboardCliInstallTargetSchema).optional(),
  shimPath: requiredString.optional(),
  fffRegistrations: z.array(WhiteboardFffManagedRegistrationSchema).optional(),
  mcpRegistrations: z.array(WhiteboardMcpRegistrationSchema).optional(),
  traceManaged: z.boolean().optional(),
  updatedAt: requiredString,
});

export type WhiteboardCliInstallStamp = z.infer<
  typeof WhiteboardCliInstallStampSchema
>;

export const WhiteboardCliInstallStatusSchema = z.strictObject({
  agents: z.array(
    z.strictObject({
      target: WhiteboardCliInstallTargetSchema,
      present: z.boolean(),
      installed: z.boolean(),
    }),
  ),
  fingerprint: requiredString,
  stamp: WhiteboardCliInstallStampSchema.nullable(),
  stale: z.boolean(),
  skills: z
    .array(
      z.strictObject({
        target: WhiteboardCliInstallTargetSchema,
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
        target: WhiteboardMcpRegistrationSchema.shape.target,
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
        target: WhiteboardFffInstallTargetSchema,
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

export type WhiteboardCliInstallStatus = z.infer<
  typeof WhiteboardCliInstallStatusSchema
>;

// Skills and FFF integrations are per-agent. Skill requests install the review
// command by default. The command, FFF binary, and trace configuration are
// per-machine. Silent app updates omit `fff` and `trace`, so they do not run an
// FFF installer or contact R2.
export const WhiteboardCliInstallApplyRequestSchema = z
  .strictObject({
    targets: z.array(WhiteboardCliInstallTargetSchema),
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

export type WhiteboardCliInstallApplyRequest = z.infer<
  typeof WhiteboardCliInstallApplyRequestSchema
>;

export const WhiteboardCliInstallApplyResponseSchema = z.strictObject({
  ok: z.boolean(),
  output: stringAllowEmpty,
  shimPath: requiredString.optional(),
});

export type WhiteboardCliInstallApplyResponse = z.infer<
  typeof WhiteboardCliInstallApplyResponseSchema
>;

export const WhiteboardDiffFileSchema = z.strictObject({
  path: requiredString,
  previousPath: requiredString.optional(),
  status: z.enum(["added", "modified", "deleted", "renamed", "unchanged"]),
  additions: nonNegativeInteger,
  deletions: nonNegativeInteger,
  patch: requiredString.optional(),
});

export type WhiteboardDiffFileWire = z.infer<typeof WhiteboardDiffFileSchema>;

export interface WhiteboardDiffStats {
  readonly fileCount: number;
  readonly additions: number;
  readonly deletions: number;
}

export function summarizeWhiteboardDiffFiles(
  files: readonly {
    readonly additions?: number;
    readonly deletions?: number;
  }[],
): WhiteboardDiffStats {
  return files.reduce<WhiteboardDiffStats>(
    (total, file) => ({
      fileCount: total.fileCount + 1,
      additions: total.additions + (file.additions ?? 0),
      deletions: total.deletions + (file.deletions ?? 0),
    }),
    { fileCount: 0, additions: 0, deletions: 0 },
  );
}

export const WhiteboardDiffFilesRequestSchema = z.strictObject({
  includePatch: z.boolean().optional(),
  paths: z.array(z.string()).optional(),
  commit: z
    .string({ error: "must be a 40-hex revision" })
    .regex(/^[0-9a-f]{40}$/i, "must be a 40-hex revision")
    .optional(),
});

export type WhiteboardDiffFilesRequest = z.infer<
  typeof WhiteboardDiffFilesRequestSchema
>;

export const WhiteboardDiffFilesResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    baseRef: requiredString.optional(),
    headRef: requiredString.optional(),
    files: z.array(WhiteboardDiffFileSchema),
  }),
  WhiteboardErrorResponseSchema,
]);

export type WhiteboardDiffFilesResponse = z.infer<
  typeof WhiteboardDiffFilesResponseSchema
>;

export const WhiteboardFileContentRequestSchema = z.strictObject({
  path: requiredString,
  side: whiteboardDiffSideSchema,
  commit: z
    .string({ error: "must be a 40-hex revision" })
    .regex(/^[0-9a-f]{40}$/i, "must be a 40-hex revision")
    .optional(),
});

export type WhiteboardFileContentRequest = z.infer<
  typeof WhiteboardFileContentRequestSchema
>;

export const WhiteboardFileContentResponseSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    content: stringAllowEmpty,
    truncated: z.boolean().optional(),
  }),
  z.strictObject({ ok: z.literal(true), absent: z.literal(true) }),
  z.strictObject({ ok: z.literal(true), binary: z.literal(true) }),
  WhiteboardErrorResponseSchema,
]);

export type WhiteboardFileContentResponse = z.infer<
  typeof WhiteboardFileContentResponseSchema
>;

export const WhiteboardRangeSchema = z
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

export type WhiteboardRangeWire = z.infer<typeof WhiteboardRangeSchema>;

export const WhiteboardOpenEditorSchema = z.strictObject({
  path: requiredString,
  scheme: requiredString,
});

export type WhiteboardOpenEditorWire = z.infer<
  typeof WhiteboardOpenEditorSchema
>;

export const WhiteboardEditorSelectionSchema = z.strictObject({
  path: requiredString,
  startLine: positiveInteger,
  startColumn: positiveInteger,
  endLine: positiveInteger,
  endColumn: positiveInteger,
});

export type WhiteboardEditorSelectionWire = z.infer<
  typeof WhiteboardEditorSelectionSchema
>;

export const WhiteboardDesktopStateSchema = z.strictObject({
  openEditors: z.array(WhiteboardOpenEditorSchema),
  activeEditor: WhiteboardOpenEditorSchema.nullable(),
  selection: WhiteboardEditorSelectionSchema.nullable(),
});

export type WhiteboardDesktopState = z.infer<
  typeof WhiteboardDesktopStateSchema
>;

const revealArgsSchema = z
  .strictObject({
    path: requiredString,
    startLine: positiveInteger,
    endLine: positiveInteger,
    side: whiteboardDiffSideSchema.optional(),
    pins: z
      .strictObject({
        repositoryId: requiredString,
        head: requiredString,
        base: requiredString.optional(),
      })
      .optional(),
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

export const WHITEBOARD_DISCORD_URL = "https://discord.gg/wYvd2cpMQg";

/** The one scratchpad's fixed review id. */
export const SCRATCHPAD_SESSION_ID = "scratchpad";

const apiWhiteboardIdSchema = z.union([
  z.uuid(),
  z.string().regex(/^shared-[a-f0-9]{64}$/),
  z.literal(SCRATCHPAD_SESSION_ID),
]);

export const WhiteboardVerbRequestSchema = z.discriminatedUnion("name", [
  z.strictObject({
    name: z.literal("authoringCapabilities"),
    args: z.strictObject({}),
  }),
  z.strictObject({ name: z.literal("joinDiscord"), args: z.strictObject({}) }),
  z.strictObject({
    name: z.literal("showWhiteboardView"),
    args: z.strictObject({ view: whiteboardViewSchema }),
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
    name: z.literal("openWhiteboardRevision"),
    args: z.strictObject({
      revision: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .optional(),
      sealedAt: positiveInteger.optional(),
    }),
  }),
  z.strictObject({
    name: z.literal("openWhiteboard"),
    args: z.strictObject({
      sessionId: apiWhiteboardIdSchema,
      active: z.boolean(),
    }),
  }),
  z.strictObject({
    name: z.literal("openApiWhiteboard"),
    args: z.strictObject({
      sessionId: apiWhiteboardIdSchema,
      title: requiredString,
    }),
  }),
]);

export type WhiteboardVerbRequest = z.infer<typeof WhiteboardVerbRequestSchema>;

export const WhiteboardVerbResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), result: z.unknown().optional() }),
  WhiteboardErrorResponseSchema,
]);

export type WhiteboardVerbResponse = z.infer<
  typeof WhiteboardVerbResponseSchema
>;

export const WhiteboardDesktopVerbFrameSchema = z.strictObject({
  event: z.literal("desktop-verb"),
  id: requiredString,
  request: WhiteboardVerbRequestSchema,
});

export type WhiteboardDesktopVerbFrame = z.infer<
  typeof WhiteboardDesktopVerbFrameSchema
>;

export const WhiteboardDesktopVerbResultSchema = z.strictObject({
  id: requiredString,
  response: WhiteboardVerbResponseSchema,
});

export type WhiteboardDesktopVerbResult = z.infer<
  typeof WhiteboardDesktopVerbResultSchema
>;

export const WhiteboardSelectedDiffSchema = z.strictObject({
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

export const WhiteboardApiSelectionSourceSchema = z.strictObject({
  sessionId: requiredString,
  version: z.number().int().nonnegative(),
  commit: requiredString.optional(),
  pins: z
    .strictObject({
      repositoryId: requiredString,
      head: requiredString,
      base: requiredString.optional(),
    })
    .optional(),
});

export const WhiteboardSurfaceEventSchema = z.discriminatedUnion("event", [
  z.strictObject({
    event: z.literal("editorSelectionChanged"),
    sessionId: requiredString,
    apiSource: WhiteboardApiSelectionSourceSchema.optional(),
    anchor: z.object({ x: z.number(), y: z.number() }).optional(),
    path: requiredString,
    range: WhiteboardRangeSchema,
    sideContext: whiteboardDiffSideSchema,
    isEmpty: z.boolean(),
    selectedDiff: WhiteboardSelectedDiffSchema.optional(),
  }),
  z.strictObject({
    event: z.literal("themeChanged"),
    theme: whiteboardThemeSchema,
  }),
  z.strictObject({
    event: z.literal("showWhiteboardView"),
    view: whiteboardViewSchema,
  }),
]);

export type WhiteboardSurfaceEvent = z.infer<
  typeof WhiteboardSurfaceEventSchema
>;

// --- Agent trace view & trace quotes ----------------------------------------

export const WhiteboardAgentTraceListResponseSchema = z.discriminatedUnion(
  "ok",
  [
    z.strictObject({
      ok: z.literal(true),
      configured: z.boolean().default(true),
      storage: z.enum(["s3", "hosted", "none"]).optional(),
      sources: z.array(z.enum(["s3", "hosted"])).optional(),
      storageError: requiredString.optional(),
      sessions: z.array(WhiteboardAgentTraceSessionSchema),
    }),
    WhiteboardErrorResponseSchema,
  ],
);

export type WhiteboardAgentTraceListResponse = z.infer<
  typeof WhiteboardAgentTraceListResponseSchema
>;

export const WhiteboardAgentTraceResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    parserVersion: requiredString,
    session: WhiteboardAgentTraceSessionSchema,
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
    events: z.array(WhiteboardAgentTraceEventSchema),
  }),
  WhiteboardErrorResponseSchema,
]);

export type WhiteboardAgentTraceResponse = z.infer<
  typeof WhiteboardAgentTraceResponseSchema
>;
