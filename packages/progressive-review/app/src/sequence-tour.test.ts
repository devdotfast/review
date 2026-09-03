import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  createSequence,
  createSequenceTourEntry,
  sequenceActiveMessageScrollTarget,
  sequenceActiveMessageScrollTopTarget,
  sequenceDiagramClassName,
  sequenceMessageColor,
  sequenceMessageHandleTop,
  sequenceSelfMessagePath,
} from "./diagrams";
import { createTestReviewDefinitionSession } from "./review-definition-test-utils";
import { defineSoftwareModel } from "./software-map/model";

const definitions = createTestReviewDefinitionSession();
const { defineActors, defineAnchors } = definitions;

describe("sequence diagram guided tour", () => {
  it("uses the same colours for sequence lines and arrowheads", () => {
    expect(sequenceMessageColor(false)).toBe("var(--edge-muted)");
    expect(sequenceMessageColor(true)).toBe("var(--accent)");
  });

  it("separates self-message handles and connects the loop to its target", () => {
    const selfMessage = {
      from: { id: "worker" },
      to: { id: "worker" },
    };
    expect(sequenceMessageHandleTop(selfMessage, "source", 112)).toBe(112);
    expect(sequenceMessageHandleTop(selfMessage, "target", 112)).toBe(136);
    expect(
      sequenceSelfMessagePath({
        sourceX: 100,
        sourceY: 112,
        targetX: 100,
        targetY: 136,
        width: 400,
      }),
    ).toBe("M 100 112 H 154 V 136 H 100");
  });

  it("turns anchored messages into ordered code-tour stops", async () => {
    const actors = defineActors({
      auth: { label: "Better Auth" },
      org: { label: "Organization helper" },
      db: { label: "Web D1" },
      settings: { label: "Settings page" },
    });
    const anchors = defineAnchors({
      authUserWrite: anchorWithPeek("Better Auth writes the user row"),
      orgCreate: anchorWithPeek("Organization helper creates the workspace"),
      settingsOrgRead: anchorWithPeek("Settings reads organization state"),
    });

    const sequence = createSequence({
      label: "Sign in and workspace bootstrap",
      messages: [
        {
          from: actors.auth,
          to: actors.db,
          label: "write user",
          anchor: anchors.authUserWrite,
        },
        {
          from: actors.org,
          to: actors.db,
          label: "create organization",
          anchor: anchors.orgCreate,
        },
        {
          from: actors.db,
          to: actors.settings,
          label: "read organization",
          anchor: anchors.settingsOrgRead,
        },
      ],
    });
    await definitions.ready();
    const tour = createSequenceTourEntry(sequence);

    expect(tour.title).toBe("Sign in and workspace bootstrap");
    expect(tour.stops).toMatchObject([
      {
        anchor: { id: "authUserWrite" },
        label: "write user",
        detail: "Better Auth -> Web D1",
        content: { kind: "resolved-code" },
      },
      {
        anchor: { id: "orgCreate" },
        label: "create organization",
        detail: "Organization helper -> Web D1",
        content: { kind: "resolved-code" },
      },
      {
        anchor: { id: "settingsOrgRead" },
        label: "read organization",
        detail: "Web D1 -> Settings page",
        content: { kind: "resolved-code" },
      },
    ]);
    expect(sequence.participants.map((participant) => participant.id)).toEqual([
      "auth",
      "org",
      "db",
      "settings",
    ]);
  });

  it("derives stable participant ids for inline sequence actors", () => {
    const anchors = defineAnchors({
      targetFrontmatter: anchorWithPeek("Software map frontmatter target"),
      targetResolution: anchorWithPeek("Shared map and graph target"),
      mapMaterialization: anchorWithPeek("Head/base map materialization"),
      reviewDocuments: anchorWithPeek("Review document map imports"),
    });

    const sequence = createSequence({
      label: "Review target resolution",
      messages: [
        {
          from: { label: "Review MDX" },
          to: { label: "Target parser" },
          label: "parse softwareMap frontmatter",
          anchor: anchors.targetFrontmatter,
        },
        {
          from: { label: "Target parser" },
          to: { label: "Graph resolver" },
          label: "resolve head/base graph target",
          anchor: anchors.targetResolution,
        },
        {
          from: { label: "Review MDX" },
          to: { label: "Map loader" },
          label: "materialize head/base maps",
          anchor: anchors.mapMaterialization,
        },
        {
          from: { label: "Map loader" },
          to: { label: "Map tab" },
          label: "diff topology and render",
          anchor: anchors.reviewDocuments,
        },
      ],
    });

    expect(
      sequence.participants.map((participant) => [
        participant.id,
        participant.label,
      ]),
    ).toEqual([
      ["inline-review-mdx", "Review MDX"],
      ["inline-target-parser", "Target parser"],
      ["inline-graph-resolver", "Graph resolver"],
      ["inline-map-loader", "Map loader"],
      ["inline-map-tab", "Map tab"],
    ]);
    expect(
      sequence.messages.map((message) => [message.from.id, message.to.id]),
    ).toEqual([
      ["inline-review-mdx", "inline-target-parser"],
      ["inline-target-parser", "inline-graph-resolver"],
      ["inline-review-mdx", "inline-map-loader"],
      ["inline-map-loader", "inline-map-tab"],
    ]);
  });

  it("derives sequence actors from software map elements", () => {
    const model = defineSoftwareModel({
      systems: {
        progressiveReview: {
          label: "Progressive Review",
          containers: {
            reviewApp: {
              label: "Review app",
              components: {
                dbLens: { label: "Database lens" },
                map: { label: "Software map" },
              },
            },
          },
        },
      },
    });
    const definitions = createTestReviewDefinitionSession({
      softwareMap: model,
    });
    const actors = definitions.defineSoftwareActors(model, {
      dbLens: "progressiveReview.reviewApp.dbLens",
      map: {
        path: "progressiveReview.reviewApp.map",
        label: "Map tab",
      },
    });
    const anchors = definitions.defineAnchors({
      focusMap: {
        title: "Focus map element",
        peek: { file: "src/example.ts", fromLine: 1, toLine: 3 },
        softwareMapPath: "progressiveReview.reviewApp.map",
      },
    });

    const sequence = createSequence({
      label: "Map-backed inline sequence",
      messages: [
        {
          from: actors.dbLens,
          to: actors.map,
          label: "opens element",
          anchor: anchors.focusMap,
        },
      ],
    });

    expect(sequence.participants).toMatchObject([
      {
        id: "dbLens",
        label: "Database lens",
        softwareMapPath: "progressiveReview.reviewApp.dbLens",
      },
      {
        id: "map",
        label: "Map tab",
        softwareMapPath: "progressiveReview.reviewApp.map",
      },
    ]);
    expect(sequence.messages[0]?.anchor.softwareMapPath).toBe(
      "progressiveReview.reviewApp.map",
    );
  });

  it("synthesizes stable anchors for sequence messages with inline code", () => {
    const sequence = createSequence({
      label: "Label readability",
      messages: [
        {
          from: { label: "Code element node" },
          to: { label: "Symbol label" },
          label: "allocates more horizontal room",
          code: { language: "bash", text: "review map init/update" },
        },
      ],
    });

    expect(sequence.messages[0]?.anchor).toMatchObject({
      id: "sequence-label-readability-message-1",
      title: "allocates more horizontal room",
    });
    expect(createSequenceTourEntry(sequence).stops).toEqual([
      {
        anchor: sequence.messages[0]!.anchor,
        label: "allocates more horizontal room",
        detail: "Code element node -> Symbol label",
        content: {
          kind: "inline-code",
          language: "bash",
          text: "review map init/update",
        },
      },
    ]);
    expect(sequence.messages[0]?.code).toEqual({
      language: "bash",
      text: "review map init/update",
    });
  });

  it("rejects sequence messages without code evidence", () => {
    expectZodIssue(
      () =>
        createSequence({
          label: "No evidence",
          messages: [
            {
              from: { label: "Reviewer" },
              to: { label: "Map CLI" },
              label: "run review map init/update",
            },
          ],
        }),
      ["messages", 0],
    );
  });

  it("rejects sequence message anchors without CodePeek settings", () => {
    const anchors = defineAnchors({
      mapCommand: "Run the map command",
    });

    expectZodIssue(
      () =>
        createSequence({
          label: "No code anchor",
          messages: [
            {
              from: { label: "Reviewer" },
              to: { label: "Map CLI" },
              label: "run review map init/update",
              anchor: anchors.mapCommand,
            },
          ],
        }),
      ["messages", 0],
    );
  });

  it("allows one code anchor to support multiple sequence messages", async () => {
    const anchors = defineAnchors({
      request: {
        title: "Request",
        peek: { file: "src/example.ts", fromLine: 1, toLine: 3 },
      },
    });
    const sequence = createSequence({
      label: "Reuse",
      messages: [
        {
          from: { label: "A" },
          to: { label: "B" },
          label: "Send",
          anchor: anchors.request,
        },
        {
          from: { label: "B" },
          to: { label: "A" },
          label: "Reply",
          anchor: anchors.request,
        },
      ],
    });

    expect(sequence.messages.map((message) => message.anchor.id)).toEqual([
      "request",
      "request--sequence-use-2",
    ]);
    expect(sequence.messages[1]?.anchor.peek).toBe(anchors.request.peek);
    await definitions.ready();
    expect(
      createSequenceTourEntry(sequence).stops.map((stop) => stop.anchor.id),
    ).toEqual(["request", "request--sequence-use-2"]);
  });

  it("rejects ambiguous parallel edge label paths", () => {
    expectZodIssue(
      () =>
        createSequence({
          label: "Ambiguous edges",
          messages: [
            {
              from: { label: "Browser" },
              to: { label: "Worker" },
              label: "Send",
              code: "first",
            },
            {
              from: { label: "Browser" },
              to: { label: "Worker" },
              label: "Send",
              code: "second",
            },
          ],
        }),
      ["messages", 1, "label"],
      "Label must be unique among parallel Browser→Worker messages",
    );
  });

  it("rejects sibling participants with duplicate labels", () => {
    expectZodIssue(
      () =>
        createSequence({
          label: "Ambiguous nodes",
          messages: [
            {
              from: { id: "first", label: "Worker" },
              to: { id: "second", label: "Worker" },
              label: "Calls",
              code: "call",
            },
          ],
        }),
      ["messages"],
      'has more than one participant labelled "Worker"',
    );
  });

  it("calculates scroll targets that reveal the active message participants", () => {
    const actors = defineActors({
      reviewer: { label: "Reviewer" },
      app: { label: "Review app" },
      server: { label: "Server" },
      source: { label: "Source reader" },
      worker: { label: "Worker" },
    });
    const anchors = defineAnchors({
      localPreview: anchorWithPeek("Open local preview"),
      sourceLookup: anchorWithPeek("Resolve source range"),
      workerRefresh: anchorWithPeek("Refresh worker evidence"),
    });
    const sequence = createSequence({
      label: "Evidence tour",
      messages: [
        {
          from: actors.reviewer,
          to: actors.app,
          label: "open preview",
          anchor: anchors.localPreview,
        },
        {
          from: actors.app,
          to: actors.server,
          label: "resolve source range",
          anchor: anchors.sourceLookup,
        },
        {
          from: actors.source,
          to: actors.worker,
          label: "refresh worker evidence",
          anchor: anchors.workerRefresh,
        },
      ],
    });
    const baseScrollInput = {
      sequence,
      laneWidth: 176,
      viewportWidth: 420,
      scrollWidth: 880,
    };

    expect(
      sequenceActiveMessageScrollTarget({
        ...baseScrollInput,
        activeAnchor: "workerRefresh",
        currentScrollLeft: 0,
      }),
    ).toBe(460);
    expect(
      sequenceActiveMessageScrollTarget({
        ...baseScrollInput,
        activeAnchor: "sourceLookup",
        currentScrollLeft: 150,
      }),
    ).toBe(150);
    expect(
      sequenceActiveMessageScrollTarget({
        ...baseScrollInput,
        activeAnchor: "sourceLookup",
        currentScrollLeft: 480,
      }),
    ).toBe(152);
    expect(
      sequenceActiveMessageScrollTarget({
        ...baseScrollInput,
        activeAnchor: "missing",
        currentScrollLeft: 0,
      }),
    ).toBeNull();

    // Vertical counterpart: rows at messageTop + index * messageGap must be
    // brought into the capped, scrollable diagram body as the tour advances.
    const baseScrollTopInput = {
      sequence,
      messageTop: 112,
      messageGap: 76,
      viewportHeight: 200,
      scrollHeight: 990,
    };
    expect(
      sequenceActiveMessageScrollTopTarget({
        ...baseScrollTopInput,
        activeAnchor: "workerRefresh",
        currentScrollTop: 0,
      }),
    ).toBe(164);
    expect(
      sequenceActiveMessageScrollTopTarget({
        ...baseScrollTopInput,
        activeAnchor: "localPreview",
        currentScrollTop: 50,
      }),
    ).toBe(50);
    expect(
      sequenceActiveMessageScrollTopTarget({
        ...baseScrollTopInput,
        activeAnchor: "localPreview",
        currentScrollTop: 400,
      }),
    ).toBe(88);
    expect(
      sequenceActiveMessageScrollTopTarget({
        ...baseScrollTopInput,
        activeAnchor: "missing",
        currentScrollTop: 0,
      }),
    ).toBeNull();
    expect(
      sequenceActiveMessageScrollTopTarget({
        ...baseScrollTopInput,
        scrollHeight: 200,
        activeAnchor: "workerRefresh",
        currentScrollTop: 0,
      }),
    ).toBeNull();
  });

  it("marks a sequence diagram while its tour is active", () => {
    expect(sequenceDiagramClassName(true)).toContain("sequence-tour--active");
    expect(sequenceDiagramClassName(false)).not.toContain(
      "sequence-tour--active",
    );
  });
});

function expectZodIssue(
  run: () => void,
  path: PropertyKey[],
  message?: string,
): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ZodError);
  const error = caught as ZodError;
  expect(error.issues[0]?.path).toEqual(path);
  expect(error.issues[0]?.message).toContain(message ?? "");
}

function anchorWithPeek(title: string) {
  return { title, peek: { file: "src/example.ts", fromLine: 1, toLine: 3 } };
}
