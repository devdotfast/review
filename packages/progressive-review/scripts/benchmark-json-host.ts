/** Real Desktop acceptance runner. It never starts an app, writes a review file,
 * sends synthetic canvas reports, or substitutes a headless renderer.
 *
 * Run with this checkout's Node/tsx after starting its isolated Desktop build:
 *   node --import tsx scripts/benchmark-json-host.ts --help
 * Output is NDJSON; tokens and private discovery contents are never printed.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  HOST_LIMITS,
  type HostCanvasObservation,
  type HostDocument,
  type HostDocumentOperation,
  type HostMap,
  type HostNode,
  type HostSourceRange,
  type HostSourceSpan,
  type JsonValue,
  ReviewClient,
  ReviewClientError,
  validateHostDocument,
} from "@dev.fast/review-protocol";
import sharp from "sharp";

import { LocalHostClient, readHostDiscovery } from "../src/host/host-discovery";

type FixtureReferences = {
  baseRange: HostSourceRange;
  headRange: HostSourceRange;
  mapVersionId: string;
  traceId: string;
  eventId: string;
  assetId: string;
};
type Measurement = {
  operation: string;
  reviewId: string;
  documentVersion: number;
  nodeCount: number;
  acceptMs: number;
  frontendObservedMs: number;
  acceptedToObservedMs: number;
  canvasSessionId: string;
  canvasReceivedAt: string;
};
type Options = {
  home: string;
  repositoryPath: string;
  sourceFile: string;
  baseRef: string;
  headRef: string;
  mode: "gallery" | "benchmark" | "all" | "verify";
  sizes: number[];
  samples: number;
  liveDelayMs: number;
  reportTimeoutMs: number;
  reviewId?: string;
  expectedHash?: string;
  previousInstanceId?: string;
};
const traceText = "Review API accepted an atomic document update.";

/** A real mixed document, including shared source definitions, repeated diagram
 * labels, reused evidence and rich nodes; no generated source-code assertions. */
export function fixtureDocument(
  refs: FixtureReferences,
  count = 16,
): HostDocument {
  if (count < 16 || count > HOST_LIMITS.nodes)
    throw new Error(
      `Fixture size must be between 16 and ${HOST_LIMITS.nodes}.`,
    );
  const definitions: HostDocument["definitions"] = {
    base_source: {
      kind: "anchor",
      title: "Pinned base command",
      source: refs.baseRange,
    },
    head_source: {
      kind: "anchor",
      title: "Pinned head command",
      source: refs.headRange,
    },
    agent: { kind: "actor", label: "Review client" },
    host: {
      kind: "actor",
      label: "Review Host",
      mapElement: { mapVersionId: refs.mapVersionId, elementId: "host" },
    },
    host_reader: { kind: "actor", label: "Review Host" },
    database: {
      kind: "store",
      label: "Shared review database",
      storage: "relational",
      collections: {
        reviews: {
          label: "Reviews",
          fields: {
            id: {
              label: "ID",
              dataType: "uuid",
              nullable: false,
              primaryKey: true,
            },
            version: {
              label: "Document version",
              dataType: "integer",
              nullable: false,
              primaryKey: false,
            },
          },
        },
      },
    },
  };
  const rich: HostNode[] = [
    {
      id: "heading",
      type: "heading",
      level: 1,
      content: [{ type: "text", text: "JSON-native Review · live validation" }],
    },
    {
      id: "paragraph",
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "This fixture exercises every public node type. ",
        },
        {
          type: "anchor_link",
          anchorId: "head_source",
          text: "Open the pinned source",
        },
      ],
    },
    {
      id: "markdown",
      type: "markdown",
      markdown:
        "## Incremental authoring\n\n- [x] Typed JSON\n- [x] Retained evidence\n\n| Layer | Contract |\n| --- | --- |\n| Agent | Commands and queries |\n| Canvas | Committed versions |",
    },
    {
      id: "code",
      type: "code",
      language: "typescript",
      text: 'await review.command("document.mutate", {\n  reviewId, expectedDocumentVersion, operations\n});',
      caption: "Illustrative client code, not a source quotation",
    },
    { id: "divider", type: "divider" },
    {
      id: "section",
      type: "section",
      title: "Stable collapsible section",
      defaultCollapsed: false,
      children: ["section_text"],
    },
    {
      id: "section_text",
      type: "markdown",
      markdown:
        "Collapse and reopen this section while the live document changes.",
    },
    {
      id: "callout",
      type: "callout",
      tone: "info",
      title: "Real frontend observation",
      children: ["callout_text"],
    },
    {
      id: "callout_text",
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Timings include the frontend's 100 ms report debounce and polling. They are not paint or animation-completion measurements.",
        },
      ],
    },
    {
      id: "peek",
      type: "code_peek",
      anchorId: "head_source",
      caption: "Retained, immutable source evidence",
    },
    diagramNode("sequence", "sequence"),
    diagramNode("stack", "call_stack_diff"),
    diagramNode("database_lens", "database_lens"),
    {
      id: "trace",
      type: "trace_quote",
      traceId: refs.traceId,
      eventId: refs.eventId,
      text: traceText,
    },
    {
      id: "image",
      type: "image",
      assetId: refs.assetId,
      alt: "Locally generated validation swatch",
      caption: "A PNG retained by the host, not a path on the author's machine",
    },
    {
      id: "map",
      type: "software_map",
      mapVersionId: refs.mapVersionId,
      focusElementId: "host",
    },
  ];
  const nodes: HostDocument["nodes"] = Object.fromEntries(
    rich.map((node) => [node.id, node]),
  );
  const roots = rich
    .filter((node) => node.id !== "section_text" && node.id !== "callout_text")
    .map((node) => node.id);
  // Mostly prose/code with regular diagrams and source peeks, rather than 1000
  // identical empty nodes. Maps/assets remain retained shared dependencies.
  for (let index = rich.length; index < count; index++) {
    const id = `mixed_${index}`;
    let node: HostNode;
    switch (index % 12) {
      case 0:
        node = diagramNode(id, "sequence");
        break;
      case 1:
        node = { id, type: "code_peek", anchorId: "head_source" };
        break;
      case 2:
        node = {
          id,
          type: "code",
          language: "typescript",
          text: `const observedVersion = ${index};\nawait client.query("document.get", { reviewId });`,
        };
        break;
      case 3:
        node = {
          id,
          type: "paragraph",
          content: [
            { type: "text", text: `Mixed document block ${index}. ` },
            {
              type: "anchor_link",
              anchorId: "head_source",
              text: "Verified source",
            },
          ],
        };
        break;
      case 4:
        node = diagramNode(id, "database_lens");
        break;
      case 5:
        node = {
          id,
          type: "trace_quote",
          traceId: refs.traceId,
          eventId: refs.eventId,
          text: traceText,
        };
        break;
      case 6:
        node = {
          id,
          type: "heading",
          level: 3,
          content: [{ type: "text", text: `Evidence and rendering ${index}` }],
        };
        break;
      case 7:
        node = { id, type: "code_peek", anchorId: "base_source" };
        break;
      case 8:
        node = diagramNode(id, "call_stack_diff");
        break;
      default:
        node = {
          id,
          type: "markdown",
          markdown: `### Review block ${index}\n\nThe host accepts a complete, validated change. **Stable node identity** keeps the surrounding document intact. Source evidence, diagram definitions and conversation records remain separate.\n\n- Read the accepted version.\n- Apply one atomic mutation.\n- Observe the real desktop canvas.`,
        };
    }
    nodes[id] = node;
    roots.push(id);
  }
  const document: HostDocument = {
    schemaVersion: 1,
    roots,
    nodes,
    definitions,
  };
  validateHostDocument(document);
  return document;
}

function diagramNode(
  id: string,
  type: "sequence" | "call_stack_diff" | "database_lens",
): HostNode {
  if (type === "sequence")
    return {
      id,
      type,
      title: "Repeated labels, stable identities",
      messages: [
        {
          id: "submit_first",
          fromActorId: "agent",
          toActorId: "host",
          label: "Read review",
          evidence: { kind: "anchor", anchorId: "head_source" },
          style: "call",
        },
        {
          id: "submit_second",
          fromActorId: "host",
          toActorId: "host_reader",
          label: "Read review",
          evidence: { kind: "anchor", anchorId: "head_source" },
          style: "call",
        },
        {
          id: "reply",
          fromActorId: "host",
          toActorId: "agent",
          label: "Accepted",
          evidence: { kind: "anchor", anchorId: "head_source" },
          style: "return",
        },
      ],
    };
  if (type === "call_stack_diff")
    return {
      id,
      type,
      title: "Reordered frames are moves, not changed-source claims",
      base: [
        { id: "first", anchorId: "base_source", label: "Command" },
        { id: "second", anchorId: "base_source", label: "Command" },
      ],
      head: [
        { id: "second", anchorId: "head_source", label: "Command" },
        { id: "first", anchorId: "head_source", label: "Command" },
      ],
    };
  return {
    id,
    type,
    title: "Synthetic read/write use cases",
    storeIds: ["database"],
    useCases: [
      {
        id: "read_case",
        label: "Review state",
        summary: "Validation fixture for the database-lens read path.",
        operations: [
          {
            id: "read_version",
            kind: "read",
            store: {
              storeId: "database",
              collectionId: "reviews",
              fieldId: "version",
            },
            actorId: "host",
            label: "Read version",
            anchorId: "head_source",
          },
        ],
      },
      {
        id: "write_case",
        label: "Review state",
        summary: "Validation fixture for the database-lens write path.",
        operations: [
          {
            id: "write_version",
            kind: "write",
            store: {
              storeId: "database",
              collectionId: "reviews",
              fieldId: "version",
            },
            actorId: "host",
            label: "Write version",
            anchorId: "head_source",
          },
        ],
      },
    ],
  };
}

export function fixtureSteps(
  document: HostDocument,
): { label: string; operations: HostDocumentOperation[] }[] {
  const steps: { label: string; operations: HostDocumentOperation[] }[] = [];
  let previous: string | null = null;
  const insert = (
    nodeId: string,
    parentId: string | null,
    afterId: string | null,
  ): HostDocumentOperation[] => {
    const node = document.nodes[nodeId]!;
    const children = "children" in node ? node.children : [];
    const inserted: HostNode =
      "children" in node ? { ...node, children: [] } : node;
    const operations: HostDocumentOperation[] = [
      { op: "node.insert", node: inserted, placement: { parentId, afterId } },
    ];
    let prior: string | null = null;
    for (const child of children) {
      operations.push(...insert(child, nodeId, prior));
      prior = child;
    }
    return operations;
  };
  for (const root of document.roots) {
    const operations = insert(root, null, previous);
    if (steps.length === 0)
      operations.unshift(
        ...Object.entries(document.definitions).map(
          ([id, value]): HostDocumentOperation => ({
            op: "definition.put",
            id,
            value,
          }),
        ),
      );
    steps.push({ label: document.nodes[root]!.type, operations });
    previous = root;
  }
  return steps;
}

function selectRange(
  text: string,
  file: string,
  side: "base" | "head",
): HostSourceRange {
  const lines = text.replace(/\n$/, "").split("\n");
  const command = lines.findIndex((line) => line.includes("async command("));
  const fromLine = command >= 0 ? command + 1 : 1;
  return {
    side,
    file,
    fromLine,
    toLine: Math.min(fromLine + 11, lines.length),
  };
}

function fixtureMap(span: HostSourceSpan): HostMap {
  return {
    schemaVersion: 1,
    elements: {
      client: {
        id: "client",
        parentId: null,
        label: "Review client",
        description: "Synthetic fixture client",
        kind: "component",
        source: [],
      },
      host: {
        id: "host",
        parentId: null,
        label: "Review Host",
        description: "Pinned command implementation",
        kind: "component",
        source: [span],
      },
    },
    relationships: {
      request: {
        id: "request",
        fromId: "client",
        toId: "host",
        kind: "semantic",
        label: "Commands and queries",
        explanation: "Synthetic API validation flow",
      },
    },
  };
}

async function createFixture(
  client: ReviewClient,
  repositoryId: string,
  options: Options,
  base: string,
  head: string,
  title: string,
) {
  const created = (
    await client.command("review.create", {
      repositoryId,
      change: { kind: "range", baseRef: base, headRef: head },
      title,
    })
  ).result;
  const reviewId = created.review.id;
  const [baseFile, headFile] = await Promise.all([
    client.query("source.file", {
      reviewId,
      documentVersion: 0,
      side: "base",
      file: options.sourceFile,
    }),
    client.query("source.file", {
      reviewId,
      documentVersion: 0,
      side: "head",
      file: options.sourceFile,
    }),
  ]);
  const baseRange = selectRange(
    baseFile.result.text,
    options.sourceFile,
    "base",
  );
  const headRange = selectRange(
    headFile.result.text,
    options.sourceFile,
    "head",
  );
  const span = (
    await client.query("source.read", {
      reviewId,
      documentVersion: 0,
      range: headRange,
    })
  ).result.span;
  const eventId = randomUUID();
  const image = await sharp({
    create: {
      width: 320,
      height: 64,
      channels: 3,
      background: { r: 36, g: 105, b: 142 },
    },
  })
    .png()
    .toBuffer();
  const [map, trace, asset] = await Promise.all([
    client.command("map.create", {
      reviewId,
      documentVersion: 0,
      side: "head",
      map: fixtureMap(span),
    }),
    client.command("trace.ingest", {
      reviewId,
      label: "Synthetic validation excerpt",
      events: [
        {
          id: eventId,
          ordinal: 0,
          at: new Date().toISOString(),
          kind: "assistant",
          text: traceText,
        },
      ],
    }),
    client.command("asset.upload", {
      reviewId,
      mimeType: "image/png",
      base64: image.toString("base64"),
    }),
  ]);
  const refs: FixtureReferences = {
    baseRange,
    headRange,
    mapVersionId: map.result.id,
    traceId: trace.result.id,
    eventId,
    assetId: asset.result.id,
  };
  emit({
    kind: "fixture_created",
    reviewId,
    title,
    base,
    head,
    sourceFile: options.sourceFile,
    mapVersionId: refs.mapVersionId,
    traceId: refs.traceId,
    assetId: refs.assetId,
  });
  return { reviewId, refs };
}

async function observed(
  client: ReviewClient,
  reviewId: string,
  version: number,
  expectedIds: string[],
  timeoutMs: number,
  receivedAfter = 0,
): Promise<HostCanvasObservation> {
  const deadline = performance.now() + timeoutMs;
  let last: HostCanvasObservation[] = [];
  while (performance.now() < deadline) {
    last = (await client.query("canvas.reports", { reviewId })).result;
    const current = last.filter(
      (report) =>
        report.documentVersion === version &&
        Date.parse(report.receivedAt) >= receivedAfter &&
        report.principalId !== client.connection.principal.id,
    );
    const failed = current.find((report) => report.status === "failed");
    if (failed)
      throw new Error(
        `Real canvas rejected version ${version}: ${JSON.stringify(failed.failures)}`,
      );
    const ready = current.find(
      (report) =>
        report.status === "rendered" &&
        expectedIds.every((id) => report.visibleNodeIds.includes(id)),
    );
    if (ready) return ready;
    await delay(40);
  }
  throw new Error(
    `No real frontend acknowledgment for review ${reviewId}, version ${version}, within ${timeoutMs} ms. Open its live canvas with sections expanded. Last observations: ${JSON.stringify(last.map((report) => ({ version: report.documentVersion, status: report.status, nodes: report.visibleNodeIds.length })))}`,
  );
}

async function measured(
  client: ReviewClient,
  options: Options,
  reviewId: string,
  label: string,
  expectedIds: string[],
  commit: () => Promise<{ result: { version: number } }>,
): Promise<Measurement> {
  const started = performance.now();
  const response = await commit();
  const accepted = performance.now();
  const report = await observed(
    client,
    reviewId,
    response.result.version,
    expectedIds,
    options.reportTimeoutMs,
  );
  const finished = performance.now();
  const measurement: Measurement = {
    operation: label,
    reviewId,
    documentVersion: response.result.version,
    nodeCount: expectedIds.length,
    acceptMs: rounded(accepted - started),
    frontendObservedMs: rounded(finished - started),
    acceptedToObservedMs: rounded(finished - accepted),
    canvasSessionId: report.canvasSessionId,
    canvasReceivedAt: report.receivedAt,
  };
  emit({ kind: "measurement", ...measurement });
  return measurement;
}

async function checkRejected(
  client: ReviewClient,
  reviewId: string,
  version: number,
  operations: HostDocumentOperation[],
  code: "VALIDATION_FAILED" | "VERSION_CONFLICT",
) {
  try {
    await client.command("document.mutate", {
      reviewId,
      expectedDocumentVersion: version,
      operations,
    });
  } catch (error) {
    if (error instanceof ReviewClientError && error.detail.code === code)
      return;
    throw error;
  }
  throw new Error(
    `Expected ${code}, but the host accepted the invalid mutation.`,
  );
}

async function checkAuthoringRaces(
  client: ReviewClient,
  options: Options,
  reviewId: string,
) {
  const before = (await client.query("document.get", { reviewId })).result;
  await checkRejected(
    client,
    reviewId,
    before.version,
    [
      {
        op: "node.insert",
        node: {
          id: "invalid_peek",
          type: "code_peek",
          anchorId: "missing_evidence",
        },
        placement: { parentId: null, afterId: null },
      },
    ],
    "VALIDATION_FAILED",
  );
  const afterInvalid = (await client.query("document.get", { reviewId }))
    .result;
  if (
    afterInvalid.contentHash !== before.contentHash ||
    afterInvalid.version !== before.version
  )
    throw new Error("Rejected mutation changed the canonical document.");
  const input = {
    reviewId,
    expectedDocumentVersion: before.version,
    operations: [
      {
        op: "node.replace" as const,
        node: {
          id: "heading",
          type: "heading" as const,
          level: 1 as const,
          content: [
            {
              type: "text" as const,
              text: "Idempotent concurrent authoring verified",
            },
          ],
        },
      },
    ],
  };
  const commandId = randomUUID();
  const [first, retry] = await Promise.all([
    client.command("document.mutate", input, { commandId }),
    client.command("document.mutate", input, { commandId }),
  ]);
  if (JSON.stringify(first) !== JSON.stringify(retry))
    throw new Error(
      "Identical concurrent command IDs returned different receipts.",
    );
  await checkRejected(
    client,
    reviewId,
    before.version,
    input.operations,
    "VERSION_CONFLICT",
  );
  const after = (await client.query("document.get", { reviewId })).result;
  if (after.version !== before.version + 1)
    throw new Error("Concurrent receipt retry committed more than once.");
  await observed(
    client,
    reviewId,
    after.version,
    Object.keys(after.nodes),
    options.reportTimeoutMs,
  );
  emit({
    kind: "authoring_checks",
    reviewId,
    invalidRejected: true,
    rejectionPreservedVersion: true,
    concurrentReceiptDeduplicated: true,
    staleVersionRejected: true,
  });
  return after;
}

async function gallery(
  client: ReviewClient,
  local: LocalHostClient,
  options: Options,
  repositoryId: string,
  base: string,
  head: string,
  instanceId: string,
) {
  const { reviewId, refs } = await createFixture(
    client,
    repositoryId,
    options,
    base,
    head,
    "Every JSON node · real Desktop validation",
  );
  await local.open(reviewId);
  await observed(client, reviewId, 0, [], options.reportTimeoutMs);
  const document = fixtureDocument(refs);
  const measurements: Measurement[] = [];
  const visible: string[] = [];
  let version = 0;
  for (const step of fixtureSteps(document)) {
    for (const operation of step.operations)
      if (operation.op === "node.insert") visible.push(operation.node.id);
    const measurement = await measured(
      client,
      options,
      reviewId,
      `insert.${step.label}`,
      [...visible],
      () =>
        client.command("document.mutate", {
          reviewId,
          expectedDocumentVersion: version,
          operations: step.operations,
        }),
    );
    version = measurement.documentVersion;
    measurements.push(measurement);
    if (options.liveDelayMs > 0) await delay(options.liveDelayMs);
  }
  const after = await checkAuthoringRaces(client, options, reviewId);
  const review = (await client.query("review.get", { reviewId })).result.review;
  const checkpoint = (
    await client.command("review.publish", {
      reviewId,
      expectedDocumentVersion: after.version,
      expectedReviewVersion: review.version,
      mapVersions: { base: null, head: refs.mapVersionId },
    })
  ).result;
  emit({
    kind: "gallery_complete",
    reviewId,
    checkpointId: checkpoint.id,
    documentVersion: after.version,
    contentHash: after.contentHash,
    nodeTypes: [
      ...new Set(Object.values(document.nodes).map((node) => node.type)),
    ],
    measurements,
    restartVerification: `--mode verify --review-id ${reviewId} --expected-hash ${after.contentHash} --previous-instance-id ${instanceId}`,
  });
  return reviewId;
}

async function benchmark(
  client: ReviewClient,
  local: LocalHostClient,
  options: Options,
  repositoryId: string,
  base: string,
  head: string,
) {
  for (const count of options.sizes) {
    const { reviewId, refs } = await createFixture(
      client,
      repositoryId,
      options,
      base,
      head,
      `Real Desktop benchmark · ${count} mixed nodes`,
    );
    await local.open(reviewId);
    await observed(client, reviewId, 0, [], options.reportTimeoutMs);
    const document = fixtureDocument(refs, count);
    const ids = Object.keys(document.nodes);
    const setup = await measured(
      client,
      options,
      reviewId,
      "document.replace.initial",
      ids,
      () =>
        client.command("document.replace", {
          reviewId,
          expectedDocumentVersion: 0,
          document,
        }),
    );
    let version = setup.documentVersion;
    const samples: Measurement[] = [];
    for (let sample = 0; sample < options.samples; sample++) {
      const operations: HostDocumentOperation[] = [
        {
          op: "node.replace",
          node: {
            id: "markdown",
            type: "markdown",
            markdown: `## Incremental sample ${sample + 1}\n\nThis is a small accepted change inside a ${count}-node mixed document. All other identities remain stable.\n\n- Source peeks\n- Rich diagrams\n- Retained resources`,
          },
        },
      ];
      const result = await measured(
        client,
        options,
        reviewId,
        "node.replace.warm",
        ids,
        () =>
          client.command("document.mutate", {
            reviewId,
            expectedDocumentVersion: version,
            operations,
          }),
      );
      version = result.documentVersion;
      samples.push(result);
    }
    const dependencySamples: Measurement[] = [];
    for (let sample = 0; sample < options.samples; sample++) {
      const anchor = document.definitions.head_source;
      if (!anchor || anchor.kind !== "anchor")
        throw new Error("Fixture source definition is missing.");
      const result = await measured(
        client,
        options,
        reviewId,
        "definition.label.warm",
        ids,
        () =>
          client.command("document.mutate", {
            reviewId,
            expectedDocumentVersion: version,
            operations: [
              {
                op: "definition.put",
                id: "head_source",
                value: {
                  ...anchor,
                  title: `Pinned source · label update ${sample + 1}`,
                },
              },
            ],
          }),
      );
      version = result.documentVersion;
      dependencySamples.push(result);
    }
    emit({
      kind: "benchmark_summary",
      reviewId,
      nodes: count,
      mixture: Object.fromEntries(
        [
          ...new Set(Object.values(document.nodes).map((node) => node.type)),
        ].map((type) => [
          type,
          Object.values(document.nodes).filter((node) => node.type === type)
            .length,
        ]),
      ),
      initialDocument: setup,
      nodeUpdates: summaries(samples),
      sharedDefinitionUpdates: summaries(dependencySamples),
      note: "API timings exclude discovery and resource setup. Frontend observations include 100 ms report debounce plus 40 ms polling, and are not paint/animation-complete timings.",
    });
  }
}

async function verify(
  client: ReviewClient,
  local: LocalHostClient,
  options: Options,
) {
  if (!options.reviewId || !options.expectedHash)
    throw new Error(
      "Restart verification requires --review-id and --expected-hash from the gallery result.",
    );
  const document = (
    await client.query("document.get", { reviewId: options.reviewId })
  ).result;
  if (document.contentHash !== options.expectedHash)
    throw new Error(
      "The accepted document did not retain its expected content hash.",
    );
  const resources = new Set<string>();
  for (const node of Object.values(document.nodes)) {
    if (node.type === "image" && !resources.has(node.assetId)) {
      await client.query("asset.get", {
        reviewId: document.reviewId,
        assetId: node.assetId,
      });
      resources.add(node.assetId);
    }
    if (node.type === "trace_quote" && !resources.has(node.traceId)) {
      await client.query("trace.get", {
        reviewId: document.reviewId,
        traceId: node.traceId,
      });
      resources.add(node.traceId);
    }
    if (node.type === "software_map" && !resources.has(node.mapVersionId)) {
      await client.query("map.get", {
        reviewId: document.reviewId,
        mapVersionId: node.mapVersionId,
      });
      resources.add(node.mapVersionId);
    }
  }
  const checkpoints = (
    await client.query("checkpoints.list", { reviewId: document.reviewId })
  ).result.items;
  for (const checkpoint of checkpoints)
    await client.query("checkpoint.get", {
      reviewId: document.reviewId,
      checkpointId: checkpoint.id,
    });
  await local.open(document.reviewId);
  // Startup clears observations and main() requires a different host instance.
  // An already-restored canvas need not emit again just because it is focused.
  const report = await observed(
    client,
    document.reviewId,
    document.version,
    Object.keys(document.nodes),
    options.reportTimeoutMs,
  );
  emit({
    kind: "restart_verified",
    reviewId: document.reviewId,
    documentVersion: document.version,
    contentHash: document.contentHash,
    retainedEvidence: Object.keys(document.evidence).length,
    retainedResources: resources.size,
    checkpoints: checkpoints.length,
    canvasSessionId: report.canvasSessionId,
  });
}

function summaries(samples: Measurement[]) {
  return {
    samples: samples.length,
    apiAcceptMs: statistics(samples.map((sample) => sample.acceptMs)),
    frontendObservedMs: statistics(
      samples.map((sample) => sample.frontendObservedMs),
    ),
    acceptedToObservedMs: statistics(
      samples.map((sample) => sample.acceptedToObservedMs),
    ),
  };
}
function statistics(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    min: sorted[0]!,
    median:
      sorted.length % 2
        ? sorted[middle]!
        : rounded((sorted[middle - 1]! + sorted[middle]!) / 2),
    p95: sorted[
      Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
    ]!,
    max: sorted.at(-1)!,
    mean: rounded(
      sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    ),
  };
}
function rounded(value: number) {
  return Math.round(value * 100) / 100;
}
function emit(value: JsonValue) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function parseOptions(argv: string[]): Options | null {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean" },
      home: { type: "string" },
      "repo-root": { type: "string" },
      "source-file": {
        type: "string",
        default: "packages/progressive-review/src/host/review-host.ts",
      },
      base: { type: "string", default: "HEAD" },
      head: { type: "string", default: "HEAD" },
      mode: { type: "string", default: "gallery" },
      sizes: { type: "string", default: "20,200,1000" },
      samples: { type: "string", default: "5" },
      "live-delay-ms": { type: "string", default: "0" },
      "report-timeout-ms": { type: "string", default: "60000" },
      "review-id": { type: "string" },
      "expected-hash": { type: "string" },
      "previous-instance-id": { type: "string" },
      "confirm-checkout-desktop": { type: "boolean" },
    },
  });
  if (values.help) {
    process.stdout.write(
      "Usage: node --import tsx scripts/benchmark-json-host.ts --home /absolute/isolated/review-home --repo-root /absolute/review-checkout --confirm-checkout-desktop [--mode gallery|benchmark|all|verify] [--live-delay-ms 1000] [--sizes 20,200,1000] [--samples 5] [--base HEAD] [--head HEAD]\n\nStart this checkout's real Desktop separately. This runner never launches an app. Both commits default to exact HEAD (snapshot). --source-file selects a committed file available at both pins. To verify after a manually performed restart, use --mode verify --review-id ID --expected-hash HASH --previous-instance-id INSTANCE from the earlier output. Verification requires a fresh canvas report after opening; switch away/back in Desktop if the view was already open. Every measured version requires a distinct frontend-session report; there is no headless fallback. Output is NDJSON.\n",
    );
    return null;
  }
  const home = values.home ?? process.env.DEV_REVIEW_HOME;
  if (
    !home ||
    !path.isAbsolute(home) ||
    path.resolve(home) === path.join(os.homedir(), ".dev")
  )
    throw new Error(
      "Supply an absolute isolated --home or DEV_REVIEW_HOME; the installed/default profile is forbidden.",
    );
  if (!values["repo-root"] || !path.isAbsolute(values["repo-root"]))
    throw new Error("Supply an explicit absolute --repo-root.");
  if (!values["confirm-checkout-desktop"])
    throw new Error(
      "Confirm that the running app is this checkout's isolated build with --confirm-checkout-desktop. Nothing was launched or changed.",
    );
  const mode = values.mode;
  if (
    mode !== "gallery" &&
    mode !== "benchmark" &&
    mode !== "all" &&
    mode !== "verify"
  )
    throw new Error("Invalid --mode.");
  const bounded = (text: string, minimum: number, maximum: number) => {
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
      throw new Error(
        `Expected an integer from ${minimum} through ${maximum}.`,
      );
    return value;
  };
  return {
    home: path.resolve(home),
    repositoryPath: path.resolve(values["repo-root"]),
    sourceFile: values["source-file"],
    baseRef: values.base,
    headRef: values.head,
    mode,
    sizes: values.sizes.split(",").map((value) => bounded(value, 16, 1000)),
    samples: bounded(values.samples, 1, 30),
    liveDelayMs: bounded(values["live-delay-ms"], 0, 5000),
    reportTimeoutMs: bounded(values["report-timeout-ms"], 1000, 120000),
    reviewId: values["review-id"],
    expectedHash: values["expected-hash"],
    previousInstanceId: values["previous-instance-id"],
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (!options) return;
  const env = { DEV_REVIEW_HOME: options.home };
  const local = new LocalHostClient({ env });
  const connection = await local.connection(); // Includes live Desktop-instance validation.
  const discovery = await readHostDiscovery(env);
  const client = await ReviewClient.connect({
    serverUrl: discovery.url,
    token: discovery.token,
  });
  if (
    client.connection.hostId !== connection.hostId ||
    client.connection.workspaceId !== connection.workspaceId
  )
    throw new Error(
      "Desktop identity changed while connecting; retry explicitly.",
    );
  const capabilities = (await client.query("capabilities", {})).result;
  if (!capabilities.queries.includes("canvas.reports"))
    throw new Error(
      "This host cannot report real frontend observations; no benchmark was run.",
    );
  emit({
    kind: "environment",
    hostId: connection.hostId,
    workspaceId: connection.workspaceId,
    instanceId: discovery.instanceId,
    appPid: discovery.appPid,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    cpus: os.cpus().length,
    memoryBytes: os.totalmem(),
    renderer: capabilities.rendererVersion,
    frontendReportDebounceMs: 100,
    observationPollMs: 40,
    mode: options.mode,
  });
  if (options.mode === "verify") {
    if (
      !options.previousInstanceId ||
      options.previousInstanceId === discovery.instanceId
    )
      throw new Error(
        "Restart verification requires --previous-instance-id from an earlier run and a different running Desktop instance.",
      );
    await verify(client, local, options);
    return;
  }
  const resolveCommit = (ref: string) =>
    execFileSync(
      "git",
      [
        "-C",
        options.repositoryPath,
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${ref}^{commit}`,
      ],
      { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  const base = resolveCommit(options.baseRef),
    head = resolveCommit(options.headRef);
  const repositoryId = (
    await client.command("repository.register", {
      path: options.repositoryPath,
    })
  ).result.id;
  let galleryId: string | undefined;
  if (options.mode === "gallery" || options.mode === "all")
    galleryId = await gallery(
      client,
      local,
      options,
      repositoryId,
      base,
      head,
      discovery.instanceId,
    );
  if (options.mode === "benchmark" || options.mode === "all")
    await benchmark(client, local, options, repositoryId, base, head);
  if (galleryId) await local.open(galleryId);
  emit({
    kind: "complete",
    mode: options.mode,
    galleryReviewId: galleryId ?? null,
    note: "Reviews are retained in the isolated profile. No app was launched; source checkouts were not edited and review files/SQL were never accessed directly.",
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    await main();
  } catch (error) {
    emit({
      kind: "failed",
      error:
        error instanceof ReviewClientError
          ? { code: error.detail.code, message: error.detail.message }
          : {
              code: "VALIDATION_RUNNER_FAILED",
              message:
                error instanceof Error
                  ? error.message
                  : "Validation runner failed.",
            },
    });
    process.exitCode = 1;
  }
}
