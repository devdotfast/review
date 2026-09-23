import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  errorMessage,
  extractTraceEventText,
  loadWhiteboardAgentTrace,
} from "@dev.fast/trace-core";
import { parseJsonText } from "@dev.fast/whiteboard-protocol";

import {
  type CallStackDiffProps,
  type CodePeekProps,
  type CodePeekValidationContext,
  type WhiteboardDefinitionSession,
  calls,
  createWhiteboardDefinitionSession,
} from "./authoring";
import {
  type CallStackChangedLines,
  type CallStackSide,
  callStackEvidenceErrors,
  diffCallStacks,
} from "./call-stack-diff";
import { callStackFrames } from "./call-stack-frames";
import { textIncludesQuote } from "./evidence";
import {
  type NormalizedSoftwareModel,
  type SoftwareModelData,
  defineSoftwareMap,
  isNormalizedSoftwareModel,
  softwareModelData,
  softwareModelDataSchema,
} from "./software-map-model";
import {
  checkSourcePath,
  requireVisibleSource,
  sliceSourceRange,
} from "./source";
import { span, startSpan } from "./startup-trace";
import {
  WHITEBOARD_DOCUMENT_FORMAT,
  type WhiteboardDocumentData,
  whiteboardDocumentDataSchema,
} from "./whiteboard-document-data";
import {
  type CollectedWhiteboardAnchors,
  type MaterializedWhiteboardNode,
  type WhiteboardDocumentExport,
  type WhiteboardDocumentModuleExports,
  collectDocumentSoftwareModels,
  collectWhiteboardAnchors,
  materializeWhiteboardDocument,
} from "./whiteboard-document-materialize";
import {
  type PublishAuditTraceQuote,
  type WhiteboardDocumentPublishAudit,
  auditWhiteboardDocumentComponent,
  createPublishValidationReact,
  isPublishAuditComponent,
} from "./whiteboard-publish-element-audit";

export interface WhiteboardPublishSourceTarget {
  sourceRootPath: string;
}

export interface WhiteboardPublishEvidenceTargets {
  head: WhiteboardPublishSourceTarget;
  base?: WhiteboardPublishSourceTarget;
}

export interface WhiteboardPublishRangePeek extends CodePeekProps {
  anchorId?: string;
}

export interface WhiteboardPublishEvaluationResult {
  document: WhiteboardDocumentData | null;
  legacySoftwareMap?: {
    head: NormalizedSoftwareModel;
    base: NormalizedSoftwareModel;
  };
  // Number of code peeks the document resolved. Zero means source preparation
  // never ran.
  peekCount: number;
  rangePeeks: WhiteboardPublishRangePeek[];
  errors: string[];
  warnings: string[];
}

export type PublishValidationRuntime = ReturnType<
  typeof validationRuntimeExports
>;

export interface WhiteboardPublishEvaluationInput {
  prepareEvidence?: () => Promise<WhiteboardPublishEvidenceTargets>;
  // Changed lines between the pinned commits, for CallStackDiff evidence:
  // a "-" frame must anchor deleted lines and a "+" frame added lines.
  resolveChangedLines?: (
    file: string,
    side: CallStackSide,
  ) => Promise<CallStackChangedLines | null>;
  ranges?: "validate" | "skip";
}

/** Shared evidence and JSON audit. The caller owns the module loader's
 * lifetime; sealed legacy loading and native authoring use this same gate. */
export async function evaluateWhiteboardDocumentForPublish(
  input: WhiteboardPublishEvaluationInput,
  load: (runtime: PublishValidationRuntime) => Promise<string | null>,
): Promise<WhiteboardPublishEvaluationResult> {
  const ranges = input.ranges ?? "validate";
  const failures: string[] = [];
  const rangePeeks: WhiteboardPublishRangePeek[] = [];
  const callStackProps: CallStackDiffProps[] = [];
  const traceQuotes: PublishAuditTraceQuote[] = [];
  let peekCount = 0;
  let evidencePromise: Promise<WhiteboardPublishEvidenceTargets> | null = null;
  const sessions: WhiteboardDefinitionSession[] = [];
  const definedModels: WhiteboardDocumentModuleExports = {};

  const documentCapture: PublishDocumentCapture = {
    input: null,
    audit: null,
  };

  // Evidence prepares once, on the first peek. A document without code
  // references publishes without touching a pinned worktree.
  const evidence = () => {
    if (!input.prepareEvidence) {
      throw new Error("Review source preparation is unavailable.");
    }

    return (evidencePromise ??= input.prepareEvidence());
  };

  const validateCodePeek = async (
    props: CodePeekProps,
    context?: CodePeekValidationContext,
  ): Promise<void> => {
    peekCount += 1;
    rangePeeks.push({ ...props, anchorId: context?.anchorId });

    if (ranges === "skip") return;

    const peekSpan = startSpan("evaluate: code peek", {
      detail: `${props.graph ?? "head"} ${props.file}:${props.fromLine}-${props.toLine}`,
    });

    try {
      const targets = await evidence();
      const primary = props.graph === "base" ? targets.base : targets.head;

      if (!primary) {
        throw new Error("The pinned base worktree is unavailable.");
      }

      // Authors may write "./src/x.ts"; the shared check wants the
      // repository-relative form, and the pinned worktree read tolerates both.
      const range = {
        file: path.posix.normalize(props.file),
        fromLine: props.fromLine,
        toLine: props.toLine,
      };

      checkSourcePath(range.file);

      const text = await readFile(
        path.join(primary.sourceRootPath, range.file),
        "utf8",
      );

      requireVisibleSource(sliceSourceRange(text, range), range);
      peekSpan.end();
    } catch (error) {
      peekSpan.fail();
      const message = `Code peek range ${props.file}:${props.fromLine}-${props.toLine}: ${errorMessage(error)}`;

      if (!failures.includes(message)) failures.push(message);
      throw error;
    }
  };

  const runtimeExports = validationRuntimeExports({
    captureDefinition: (value) => {
      definedModels[`definition-${Object.keys(definedModels).length}`] = value;
    },
    createSession: (session) => {
      sessions.push(session);
    },
    validateCodePeek,
    reportAuditError: (message) => {
      if (!failures.includes(message)) failures.push(message);
    },
    collectCallStackDiff: (props) => {
      callStackProps.push(props);
    },
    collectTraceQuote: (quote) => {
      traceQuotes.push(quote);
    },
    documentCapture,
  });

  const importErrorMessage = await load(runtimeExports);

  if (ranges === "validate") {
    failures.push(
      ...(await span("evaluate: call stack diffs", () =>
        validateCallStackEvidence({
          props: callStackProps,
          resolveChangedLines: input.resolveChangedLines,
        }),
      )),
    );
  }

  const traceQuoteWarnings: string[] = [];

  if (ranges === "validate" && traceQuotes.length > 0) {
    const quoted = await span("evaluate: trace quotes", async () =>
      validateTraceQuotes({
        quotes: traceQuotes,
        cwd: input.prepareEvidence
          ? (await evidence()).head.sourceRootPath
          : undefined,
      }),
    );

    failures.push(...quoted.errors);
    traceQuoteWarnings.push(...quoted.warnings);
  }

  let legacySoftwareMap: WhiteboardPublishEvaluationResult["legacySoftwareMap"];
  const headMap = documentCapture.input?.repoSoftwareMap;
  const baseMap = documentCapture.input?.baseSoftwareMap;

  if (headMap != null || baseMap != null) {
    const asJson = (map: NormalizedSoftwareModel) =>
      softwareModelDataSchema.safeParse(
        JSON.parse(JSON.stringify(softwareModelData(map))),
      ).success;

    if (
      isNormalizedSoftwareModel(headMap) &&
      isNormalizedSoftwareModel(baseMap) &&
      asJson(headMap) &&
      asJson(baseMap)
    ) {
      legacySoftwareMap = { head: headMap, base: baseMap };
    } else {
      failures.push(
        "The embedded software map must contain valid head and base models.",
      );
    }
  }

  let document: WhiteboardDocumentData | null = null;

  if (
    importErrorMessage === null &&
    failures.length === 0 &&
    documentCapture.audit &&
    documentCapture.input
  ) {
    const materialized = materializeWhiteboardDocument(documentCapture.audit);
    failures.push(...materialized.errors);

    const moduleExports: WhiteboardDocumentModuleExports = {
      ...documentCapture.input.models,
      ...definedModels,
    };

    let anchors: ReturnType<typeof collectWhiteboardAnchors> | null = null;

    try {
      anchors = collectWhiteboardAnchors(moduleExports);
    } catch (error) {
      failures.push(errorMessage(error));
    }

    if (failures.length === 0 && anchors) {
      try {
        const softwareModels = collectDocumentSoftwareModels(
          moduleExports,
          documentCapture.input.modelNames,
        ).map((model) => softwareModelData(model));

        const assembled = assembleWhiteboardDocument({
          document: documentCapture.input,
          body: materialized.body,
          anchors,
          softwareModels,
        });

        if ("document" in assembled) {
          document = assembled.document;
        } else {
          failures.push(...assembled.errors);
        }
      } catch (error) {
        failures.push(`Review document data: ${errorMessage(error)}`);
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

  const result: WhiteboardPublishEvaluationResult = {
    document,
    peekCount,
    rangePeeks,
    errors,
    warnings: [...new Set(warnings)],
  };

  if (document && legacySoftwareMap)
    result.legacySoftwareMap = legacySoftwareMap;

  return result;
}

async function validateCallStackEvidence(input: {
  props: readonly CallStackDiffProps[];
  resolveChangedLines?: (
    file: string,
    side: CallStackSide,
  ) => Promise<CallStackChangedLines | null>;
}): Promise<string[]> {
  const failures: string[] = [];

  if (input.props.length === 0) return failures;

  if (!input.resolveChangedLines) {
    return [
      "Document uses CallStackDiff but changed-line resolution is unavailable.",
    ];
  }

  const changedLines = new Map<string, CallStackChangedLines | null>();

  for (const props of input.props) {
    const rows = diffCallStacks(
      callStackFrames(props.base),
      callStackFrames(props.head),
    );

    for (const row of rows) {
      if (row.change === "unchanged") continue;
      const side: CallStackSide = row.change === "removed" ? "base" : "head";
      const file = row.frame.source.file;
      const key = `${side}\0${file}`;

      if (!changedLines.has(key)) {
        changedLines.set(key, await input.resolveChangedLines(file, side));
      }
    }

    const label = props.title
      ? `<CallStackDiff "${props.title}">`
      : "<CallStackDiff>";

    for (const message of callStackEvidenceErrors(
      rows,
      (file, side) => changedLines.get(`${side}\0${file}`) ?? null,
    )) {
      const entry = `${label} ${message}`;

      if (!failures.includes(entry)) failures.push(entry);
    }
  }

  return failures;
}

async function validateTraceQuotes(input: {
  quotes: readonly PublishAuditTraceQuote[];
  cwd?: string;
}): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const quote of input.quotes) {
    const cleanQuote = quote.text.trim();

    if (!cleanQuote) {
      errors.push(
        `<TraceQuote> in session ${quote.sessionId} has empty quote text.`,
      );
      continue;
    }

    const loaded = await loadWhiteboardAgentTrace({
      sessionId: quote.sessionId,
      trace: quote.trace,
      cwd: input.cwd,
    });

    if (!loaded) {
      errors.push(
        `<TraceQuote> session ${quote.sessionId}${quote.trace ? ` (trace ${quote.trace})` : ""} has no normalized transcript.`,
      );
      continue;
    }

    const matchingIndices: number[] = [];

    for (let i = 0; i < loaded.trace.events.length; i++) {
      const event = loaded.trace.events[i];

      if (textIncludesQuote(extractTraceEventText(event), cleanQuote))
        matchingIndices.push(i);
    }

    const quoteLabel =
      cleanQuote.length > 40 ? `${cleanQuote.slice(0, 39)}…` : cleanQuote;

    if (matchingIndices.length === 0) {
      errors.push(
        `<TraceQuote> text "${quoteLabel}" not found in session ${quote.sessionId}${quote.trace ? ` (trace ${quote.trace})` : ""}.`,
      );
    } else if (quote.event !== undefined) {
      if (!matchingIndices.includes(quote.event)) {
        if (matchingIndices.length === 1) {
          warnings.push(
            `<TraceQuote> text "${quoteLabel}" hint event={${quote.event}} is stale; matched event ${matchingIndices[0]}.`,
          );
        } else {
          warnings.push(
            `<TraceQuote> text "${quoteLabel}" matched multiple events (${matchingIndices.join(", ")}). Update hint to event={${matchingIndices[0]}} to disambiguate.`,
          );
        }
      }
    } else if (matchingIndices.length > 1) {
      warnings.push(
        `<TraceQuote> text "${quoteLabel}" matched multiple events (${matchingIndices.join(", ")}). Add event={${matchingIndices[0]}} to disambiguate.`,
      );
    }
  }

  return { errors, warnings };
}

function assembleWhiteboardDocument(input: {
  document: PublishDocumentInput;
  body: MaterializedWhiteboardNode[];
  anchors: CollectedWhiteboardAnchors;
  softwareModels: SoftwareModelData[];
}): { document: WhiteboardDocumentData } | { errors: string[] } {
  const parsed = whiteboardDocumentDataSchema.safeParse(
    parseJsonText(
      JSON.stringify({
        format: WHITEBOARD_DOCUMENT_FORMAT,
        title: input.document.title,
        routePath: input.document.routePath,
        sourcePath: path.basename(input.document.filePath),
        body: input.body,
        anchors: input.anchors.anchors,
        anchorContents: input.anchors.anchorContents,
        softwareModels: input.softwareModels,
      }),
    ),
  );

  return parsed.success
    ? { document: parsed.data }
    : {
        errors: parsed.error.issues.map(
          (issue) =>
            `Review document data: ${issue.path.join(".") || "document"}: ${issue.message}`,
        ),
      };
}

interface PublishDocumentInput {
  title: string;
  routePath: string;
  filePath: string;
  modelNames: string[];
  models: WhiteboardDocumentModuleExports;
  repoSoftwareMap?: NormalizedSoftwareModel | null;
  baseSoftwareMap?: NormalizedSoftwareModel | null;
  Component?: unknown;
}

interface PublishDocumentCapture {
  input: PublishDocumentInput | null;
  audit: WhiteboardDocumentPublishAudit | null;
}

function validationRuntimeExports(input: {
  captureDefinition: (value: WhiteboardDocumentExport) => void;
  createSession: (session: WhiteboardDefinitionSession) => void;
  validateCodePeek: (
    props: CodePeekProps,
    context?: CodePeekValidationContext,
  ) => Promise<void>;
  reportAuditError: (message: string) => void;
  collectCallStackDiff: (props: CallStackDiffProps) => void;
  collectTraceQuote: (quote: PublishAuditTraceQuote) => void;
  documentCapture: PublishDocumentCapture;
}) {
  const noop = () => undefined;
  // The React substitute is not inert: `jsx` builds element records so the
  // audit below can parse every authored element's props at publish time.
  const react = createPublishValidationReact();

  return {
    ...react,
    calls,
    defineSoftwareModel: (...args: Parameters<typeof defineSoftwareMap>) => {
      const model = defineSoftwareMap(...args);
      input.captureDefinition(model);

      return model;
    },
    setWhiteboardRequestContext: noop,
    createBrowserWhiteboardDefinitionSession: (sessionInput: {
      softwareMap?: Parameters<
        typeof createWhiteboardDefinitionSession
      >[0]["softwareMap"];
      baseSoftwareMap?: Parameters<
        typeof createWhiteboardDefinitionSession
      >[0]["baseSoftwareMap"];
      mapDependentComponents?: readonly string[];
    }) => {
      const session = createWhiteboardDefinitionSession({
        softwareMap: sessionInput.softwareMap ?? null,
        baseSoftwareMap: sessionInput.baseSoftwareMap ?? null,
        mapDependentComponents: sessionInput.mapDependentComponents,
        validateCodePeek: input.validateCodePeek,
      });

      input.createSession(session);

      // Older sealed bundles omitted imported data.ts exports from `models`.
      // Capture definitions while that exact bundle executes, including unused
      // anchors, without reading or recompiling editable authoring sources.
      return {
        ...session,
        defineAnchors: (
          anchors: Parameters<WhiteboardDefinitionSession["defineAnchors"]>[0],
        ) => {
          const defined = session.defineAnchors(anchors);
          input.captureDefinition(defined);

          return defined;
        },
      };
    },
    createActiveWhiteboardDocument: (document: PublishDocumentInput) => {
      if (!isPublishAuditComponent(document.Component)) {
        throw new Error("Review document has no component export.");
      }

      const audit = auditWhiteboardDocumentComponent({
        Component: document.Component,
        reportError: input.reportAuditError,
        collectCallStackDiff: input.collectCallStackDiff,
        collectTraceQuote: input.collectTraceQuote,
      });

      input.documentCapture.input = document;
      input.documentCapture.audit = audit;

      return document;
    },
  };
}
