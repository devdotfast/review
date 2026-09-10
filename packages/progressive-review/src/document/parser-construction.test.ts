import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  type ReviewDocumentModuleExports,
  materializeReviewDocument,
} from "../review-document-materialize";
import {
  type PublishValidationProps,
  auditReviewDocumentComponent,
  createPublishValidationReact,
  flattenChildren,
  isAuditElement,
} from "../review-publish-element-audit";
import { buildReviewDocument } from "./build";
import { constructDocument } from "./construct";
import { parseReviewDocument } from "./mdx-parser";

const runtime = createPublishValidationReact();

async function materialize(
  source: string,
  bindings: ReviewDocumentModuleExports,
) {
  const syntax = await parseReviewDocument(source);
  const errors: string[] = [];

  const audit = auditReviewDocumentComponent({
    Component: (props) =>
      constructDocument(syntax, runtime, props, [], bindings),
    reportError: (message) => errors.push(message),
  });

  expect(errors).toEqual([]);

  if (!audit) throw new Error("Expected document construction to succeed");

  return materializeReviewDocument(audit);
}

describe("document component resolution", () => {
  it("renders prose and intrinsic JSX without calling lowercase authored bindings", async () => {
    let bindingCalls = 0;

    const authored = () => {
      bindingCalls++;

      return runtime.jsx("script", { children: "Hijacked" });
    };

    const result = await materialize(
      "# Prose\n\nA paragraph with [a link](https://example.com) and `inline code`.\n\n```ts\nconst value = 1;\n```\n\n<p>Explicit paragraph</p>\n",
      { p: authored, a: authored, code: authored },
    );

    expect(bindingCalls).toBe(0);
    expect(result.errors).toEqual([]);
    const body = JSON.stringify(result.body);

    for (const tag of ["p", "a", "code", "pre"])
      expect(body).toContain(`"tag":"${tag}"`);
    expect(body).toContain("Explicit paragraph");
    expect(body).not.toContain("Hijacked");
  });

  it("resolves uppercase and dotted authored components", async () => {
    const Notice = ({ children }: PublishValidationProps) =>
      runtime.jsx("strong", { children });

    const syntax = await parseReviewDocument(
      "<Notice>Uppercase</Notice>\n\n<widgets.notice>Namespace</widgets.notice>\n",
    );

    const body = constructDocument(syntax, runtime, {}, [], {
      Notice,
      widgets: { notice: Notice },
    });

    const elements = flattenChildren(body).filter(isAuditElement);
    expect(elements).toHaveLength(2);
    expect(elements[0].type).toBe(Notice);
    expect(elements[1].type).toBe(Notice);
    expect(elements.map((element) => element.props.children)).toEqual([
      "Uppercase",
      "Namespace",
    ]);
  });

  it("retains the explicit component-map override for prose tags", async () => {
    const syntax = await parseReviewDocument("Paragraph.");
    const prose = ({ children }: PublishValidationProps) =>
      runtime.jsx("blockquote", { children });

    const body = constructDocument(
      syntax,
      runtime,
      { components: { p: prose } },
      [],
      { p: () => "Authored binding" },
    );

    const elements = flattenChildren(body).filter(isAuditElement);
    expect(elements).toHaveLength(1);
    expect(elements[0].type).toBe(prose);
    expect(elements[0].props.children).toBe("Paragraph.");
  });
});

it("propagates internal parser failures without relabeling them as authored syntax errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-parser-failure-"));
  const reviewPath = path.join(root, "review.mdx");
  const failure = new Error("Internal transformer failed");

  try {
    await writeFile(reviewPath, "# Review\n");
    await expect(
      buildReviewDocument({ reviewPath, ranges: "skip" }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
