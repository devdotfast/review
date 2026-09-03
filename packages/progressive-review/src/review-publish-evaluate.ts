import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { init as initModuleLexer, parse as parseModule } from "es-module-lexer";

import { extractTraceEventText } from "./agent-trace-parser";
import {
  type CallStackDiffProps,
  type CodePeekProps,
  type CodePeekResolution,
  type CodePeekResolutionContext,
  type ReviewDefinitionSession,
  callStackEntryAnchor,
  calls,
  createReviewDefinitionSession,
} from "./authoring";
import {
  type CallStackChangedLines,
  type CallStackSide,
  callStackEvidenceErrors,
  diffCallStacks,
} from "./call-stack-diff";
import { errorMessage } from "./error-message";
import { loadReviewAgentTrace } from "./review-agent-traces";
import {
  type PublishAuditTraceQuote,
  auditReviewDocumentComponent,
  createPublishValidationReact,
} from "./review-publish-element-audit";
import { defineSoftwareMap } from "./software-map-model";
import { resolveReviewSourceRange } from "./source-range-resolver";

// Publish evaluates the exact bundle it ships: the document module runs under
// Node with this validation runtime substituted for `review-doc-runtime`, so
// every authored code peek resolves against the pinned worktree before a
// reviewer can mount the revision. The React substitute never renders to a
// DOM, but it is not inert: `jsx` builds element records and the element
// audit parses every authored component's props against its schema (see
// review-publish-element-audit.ts).
const RUNTIME_GLOBAL = "__devFastReviewPublishRuntime";
const RUNTIME_SPECIFIER = "review-doc-runtime";
const RUNTIME_MODULE_FILE = "review-doc-runtime.mjs";
const DOCUMENT_MODULE_FILE = "review-document.mjs";

type PublishValidationRuntime = ReturnType<typeof validationRuntimeExports>;

// The generated runtime module reads its exports from this global slot: the
// evaluation installs the runtime before importing the document and restores
// whatever the slot held afterwards.
interface PublishValidationRuntimeGlobal {
  [RUNTIME_GLOBAL]?: PublishValidationRuntime;
}

// The stub module must declare every name the bundle imports from the runtime
// (ESM checks named imports at link time), so the export list is derived from
// the bundle's own import statements instead of mirroring doc-runtime.ts by
// hand. The four review exports always ship because the generated authoring
// module calls them at module scope.
const REQUIRED_EXPORT_NAMES = [
  "defineSoftwareModel",
  "createBrowserReviewDefinitionSession",
  "createActiveReviewDocument",
  "setReviewRequestContext",
] as const;

export interface ReviewPublishSourceTarget {
  sourceRootPath: string;
}

export interface ReviewPublishEvidenceTargets {
  head: ReviewPublishSourceTarget;
  base?: ReviewPublishSourceTarget;
}

export interface ReviewPublishRangePeek extends CodePeekProps {
  anchorId?: string;
}

export interface ReviewPublishEvaluationResult {
  // Number of code peeks the document resolved. Zero means source preparation
  // never ran.
  peekCount: number;
  rangePeeks: ReviewPublishRangePeek[];
  errors: string[];
  warnings: string[];
}

export async function evaluateReviewDocumentBundleForPublish(input: {
  bundleCode: string;
  reviewDir: string;
  prepareEvidence?: () => Promise<ReviewPublishEvidenceTargets>;
  // Changed lines between the pinned commits, for CallStackDiff evidence:
  // a "-" frame must anchor deleted lines and a "+" frame added lines.
  resolveChangedLines?: (
    file: string,
    side: CallStackSide,
  ) => Promise<CallStackChangedLines | null>;
  validateRanges?: boolean;
}): Promise<ReviewPublishEvaluationResult> {
  const failures: string[] = [];
  const rangePeeks: ReviewPublishRangePeek[] = [];
  const callStackProps: CallStackDiffProps[] = [];
  const traceQuotes: PublishAuditTraceQuote[] = [];
  let peekCount = 0;
  let evidencePromise: Promise<ReviewPublishEvidenceTargets> | null = null;
  const sessions: ReviewDefinitionSession[] = [];

  // Evidence prepares once, on the first peek. A document without code
  // references publishes without touching a pinned worktree.
  const evidence = () => {
    if (!input.prepareEvidence) {
      throw new Error("Review source preparation is unavailable.");
    }
    return (evidencePromise ??= input.prepareEvidence());
  };

  const resolveCodePeek = async (
    props: CodePeekProps,
    context?: CodePeekResolutionContext,
  ): Promise<CodePeekResolution> => {
    peekCount += 1;
    rangePeeks.push({ ...props, anchorId: context?.anchorId });
    if (input.validateRanges === false) {
      const sourceId = `source-range:${props.file}:${props.fromLine}-${props.toLine}`;
      return {
        snapshot: {
          roots: [{ kind: "source", sourceId }],
          resolved: {
            [sourceId]: {
              source: {
                id: sourceId,
                name: props.file,
                kind: "source-range",
                file: props.file,
                line: props.fromLine,
                endLine: props.toLine,
              },
              lines: [[{ t: props.file, k: "t" }]],
            },
          },
        },
      };
    }
    try {
      const targets = await evidence();
      const primary = props.graph === "base" ? targets.base : targets.head;
      if (!primary) {
        throw new Error("The pinned base worktree is unavailable.");
      }
      const snapshot = await resolveReviewSourceRange({
        rootPath: primary.sourceRootPath,
        root: {
          kind: "range",
          file: props.file,
          fromLine: props.fromLine,
          toLine: props.toLine,
        },
      });
      return { snapshot };
    } catch (error) {
      const message = `Code peek range ${props.file}:${props.fromLine}-${props.toLine}: ${errorMessage(error)}`;
      if (!failures.includes(message)) failures.push(message);
      throw error;
    }
  };

  const runtimeExports = validationRuntimeExports({
    createSession: (session) => {
      sessions.push(session);
    },
    resolveCodePeek,
    reportAuditError: (message) => {
      if (!failures.includes(message)) failures.push(message);
    },
    collectCallStackDiff: (props) => {
      callStackProps.push(props);
    },
    collectTraceQuote: (quote) => {
      traceQuotes.push(quote);
    },
  });

  const evaluationDir = path.join(
    input.reviewDir,
    ".build",
    `publish-validate-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  // SAFETY: the slot is a private key on globalThis that only this evaluation
  // writes; it holds a runtime from `validationRuntimeExports` or nothing.
  const globalHolder = globalThis as PublishValidationRuntimeGlobal;
  const previousRuntime = globalHolder[RUNTIME_GLOBAL];
  let importErrorMessage: string | null = null;
  try {
    const runtimeImportNames = await collectRuntimeImportNames(
      input.bundleCode,
    );
    await mkdir(evaluationDir, { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(
        path.join(evaluationDir, RUNTIME_MODULE_FILE),
        validationRuntimeModuleSource(runtimeImportNames),
        "utf8",
      ),
      writeFile(
        path.join(evaluationDir, DOCUMENT_MODULE_FILE),
        rewriteRuntimeSpecifier(input.bundleCode),
        "utf8",
      ),
    ]);
    globalHolder[RUNTIME_GLOBAL] = runtimeExports;
    const moduleUrl = pathToFileURL(
      path.join(evaluationDir, DOCUMENT_MODULE_FILE),
    );
    moduleUrl.searchParams.set("t", String(Date.now()));
    try {
      await import(moduleUrl.href);
    } catch (error) {
      importErrorMessage = errorMessage(error);
    }
  } finally {
    globalHolder[RUNTIME_GLOBAL] = previousRuntime;
    await rm(evaluationDir, { recursive: true, force: true });
  }

  // CallStackDiff evidence: the same gate as range resolution. Every "-"
  // row must anchor deleted lines and every "+" row added lines, so a
  // marker can never claim a change the diff does not contain.
  if (callStackProps.length > 0 && input.validateRanges !== false) {
    if (!input.resolveChangedLines) {
      failures.push(
        "Document uses CallStackDiff but changed-line resolution is unavailable.",
      );
    } else {
      const changedLines = new Map<string, CallStackChangedLines | null>();
      for (const props of callStackProps) {
        const rows = diffCallStacks(props.base, props.head);
        for (const row of rows) {
          if (row.change === "unchanged") continue;
          const side: CallStackSide =
            row.change === "removed" ? "base" : "head";
          const file = callStackEntryAnchor(row.entry).peek.props.file;
          const key = `${side}\0${file}`;
          if (!changedLines.has(key)) {
            changedLines.set(key, await input.resolveChangedLines(file, side));
          }
        }
        const label = props.title
          ? `<CallStackDiff "${props.title}">`
          : "<CallStackDiff>";
        const evidenceErrors = callStackEvidenceErrors(
          rows,
          (file, side) => changedLines.get(`${side}\0${file}`) ?? null,
        );
        for (const message of evidenceErrors) {
          const entry = `${label} ${message}`;
          if (!failures.includes(entry)) failures.push(entry);
        }
      }
    }
  }

  // TraceQuote resolution: every quoted string is matched against the target
  // normalized trace. Text found nowhere is a hard error; multiple matches
  // without a deciding event hint emit a warning with the event index.
  const traceQuoteWarnings: string[] = [];
  if (traceQuotes.length > 0 && input.validateRanges !== false) {
    const traceCwd = input.prepareEvidence
      ? (await evidence()).head.sourceRootPath
      : undefined;
    for (const quote of traceQuotes) {
      const cleanQuote = quote.text.trim();
      if (!cleanQuote) {
        failures.push(
          `<TraceQuote> in session ${quote.sessionId} has empty quote text.`,
        );
        continue;
      }
      const loaded = await loadReviewAgentTrace({
        sessionId: quote.sessionId,
        trace: quote.trace,
        cwd: traceCwd,
      });
      if (!loaded) {
        failures.push(
          `<TraceQuote> session ${quote.sessionId}${quote.trace ? ` (trace ${quote.trace})` : ""} has no normalized transcript.`,
        );
        continue;
      }
      const normQuote = cleanQuote.replace(/\s+/g, " ");
      const matchingIndices: number[] = [];
      for (let i = 0; i < loaded.trace.events.length; i++) {
        const ev = loaded.trace.events[i];
        const text = extractTraceEventText(ev).replace(/\s+/g, " ");
        if (text.includes(normQuote)) {
          matchingIndices.push(i);
        }
      }
      const quoteLabel =
        cleanQuote.length > 40 ? `${cleanQuote.slice(0, 39)}…` : cleanQuote;
      if (matchingIndices.length === 0) {
        failures.push(
          `<TraceQuote> text "${quoteLabel}" not found in session ${quote.sessionId}${quote.trace ? ` (trace ${quote.trace})` : ""}.`,
        );
      } else if (quote.event !== undefined) {
        if (!matchingIndices.includes(quote.event)) {
          if (matchingIndices.length === 1) {
            traceQuoteWarnings.push(
              `<TraceQuote> text "${quoteLabel}" hint event={${quote.event}} is stale; matched event ${matchingIndices[0]}.`,
            );
          } else {
            traceQuoteWarnings.push(
              `<TraceQuote> text "${quoteLabel}" matched multiple events (${matchingIndices.join(", ")}). Update hint to event={${matchingIndices[0]}} to disambiguate.`,
            );
          }
        }
      } else if (matchingIndices.length > 1) {
        traceQuoteWarnings.push(
          `<TraceQuote> text "${quoteLabel}" matched multiple events (${matchingIndices.join(", ")}). Add event={${matchingIndices[0]}} to disambiguate.`,
        );
      }
    }
  }

  const errors =
    failures.length > 0
      ? failures
      : importErrorMessage !== null
        ? [importErrorMessage]
        : [];
  const warnings = [
    ...sessions.flatMap((session) =>
      session.diagnostics.map((diagnostic) => diagnostic.message),
    ),
    ...traceQuoteWarnings,
  ];
  return {
    peekCount,
    rangePeeks,
    errors,
    warnings: [...new Set(warnings)],
  };
}

function rewriteRuntimeSpecifier(bundleCode: string): string {
  const specifier = JSON.stringify(RUNTIME_SPECIFIER);
  if (!bundleCode.includes(specifier)) {
    throw new Error("Review document bundle has no runtime import.");
  }
  return bundleCode
    .split(specifier)
    .join(JSON.stringify(`./${RUNTIME_MODULE_FILE}`));
}

async function collectRuntimeImportNames(
  bundleCode: string,
): Promise<string[]> {
  await initModuleLexer;
  const [imports] = parseModule(bundleCode);
  const names = new Set<string>(REQUIRED_EXPORT_NAMES);
  for (const record of imports) {
    if (record.n !== RUNTIME_SPECIFIER || record.d !== -1) continue;
    const statement = bundleCode.slice(record.ss, record.se);
    const clause = /^import\b([\s\S]*?)\bfrom\b/.exec(statement)?.[1];
    if (!clause) continue;
    const named = /\{([\s\S]*?)\}/.exec(clause)?.[1] ?? "";
    for (const entry of named.split(",")) {
      const name = entry.split(/\s+as\s+/)[0]!.trim();
      // `default` binds through `export default`; anything else must be a
      // plain identifier to be re-exportable as `export const <name>`.
      if (/^[A-Za-z_$][\w$]*$/.test(name) && name !== "default") {
        names.add(name);
      }
    }
    // A namespace import needs no declared names, and a default import binds
    // the stub's `export default`; only named entries add to the list.
  }
  return [...names];
}

function validationRuntimeModuleSource(exportNames: readonly string[]): string {
  return [
    `const runtime = globalThis.${RUNTIME_GLOBAL};`,
    `if (!runtime) {`,
    `  throw new Error("Review publish validation runtime is not installed.");`,
    `}`,
    // Names the curated runtime does not know become inert functions, so a new
    // doc-runtime export never fails the link or a module-scope call.
    `const get = (name) => (name in runtime ? runtime[name] : () => undefined);`,
    ...exportNames.map(
      (name) => `export const ${name} = get(${JSON.stringify(name)});`,
    ),
    `export default runtime.React;`,
    ``,
  ].join("\n");
}

function validationRuntimeExports(input: {
  createSession: (session: ReviewDefinitionSession) => void;
  resolveCodePeek: (
    props: CodePeekProps,
    context?: CodePeekResolutionContext,
  ) => Promise<CodePeekResolution>;
  reportAuditError: (message: string) => void;
  collectCallStackDiff: (props: CallStackDiffProps) => void;
  collectTraceQuote: (quote: PublishAuditTraceQuote) => void;
}) {
  const noop = () => undefined;
  // The React substitute is not inert: `jsx` builds element records so the
  // audit below can parse every authored element's props at publish time.
  const react = createPublishValidationReact();
  return {
    ...react,
    calls,
    defineSoftwareModel: defineSoftwareMap,
    setReviewRequestContext: noop,
    createBrowserReviewDefinitionSession: (sessionInput: {
      softwareMap?: Parameters<
        typeof createReviewDefinitionSession
      >[0]["softwareMap"];
      baseSoftwareMap?: Parameters<
        typeof createReviewDefinitionSession
      >[0]["baseSoftwareMap"];
      mapDependentComponents?: readonly string[];
    }) => {
      const session = createReviewDefinitionSession({
        softwareMap: sessionInput.softwareMap ?? null,
        baseSoftwareMap: sessionInput.baseSoftwareMap ?? null,
        mapDependentComponents: sessionInput.mapDependentComponents,
        resolveCodePeek: input.resolveCodePeek,
      });
      input.createSession(session);
      return session;
    },
    createActiveReviewDocument: (document: { Component?: unknown }) => {
      if (typeof document.Component !== "function") {
        throw new Error("Review document has no component export.");
      }
      auditReviewDocumentComponent({
        Component: document.Component,
        reportError: input.reportAuditError,
        collectCallStackDiff: input.collectCallStackDiff,
        collectTraceQuote: input.collectTraceQuote,
      });
      return document;
    },
  };
}
