import { isObjectValue } from "@dev.fast/review-protocol";

import type {
  ReviewDocumentExport,
  ReviewDocumentModuleExports,
} from "../review-document-materialize";
import {
  type PublishAuditNode,
  type PublishValidationProps,
  type PublishValidationReact,
  isPublishAuditComponent,
} from "../review-publish-element-audit";
import type { DocumentSyntax, DocumentSyntaxNode } from "./syntax";

/** Construction and validation do not know which parser produced the syntax. */
export function constructDocument(
  syntax: DocumentSyntax,
  runtime: PublishValidationReact,
  props: PublishValidationProps,
  evaluate: readonly ((
    components: PublishValidationProps["components"],
  ) => ReviewDocumentExport | PublishAuditNode)[],
  bindings: ReviewDocumentModuleExports,
): PublishAuditNode {
  const visit = (node: DocumentSyntaxNode): PublishAuditNode => {
    if (node.kind === "text") return node.value;
    if (node.kind === "expression") {
      // SAFETY: authored values enter the same element/JSON audit as legacy
      // component results; this is not a trusted-data assertion.
      return evaluate[node.expression](props.components) as PublishAuditNode;
    }
    const attributes: PublishValidationProps = {};
    for (const attribute of node.attributes) {
      if (attribute.kind === "spread")
        Object.assign(
          attributes,
          evaluate[attribute.expression](props.components),
        );
      else
        attributes[attribute.name] =
          attribute.kind === "literal"
            ? attribute.value
            : evaluate[attribute.expression](props.components);
    }
    const children = node.children.map(visit);
    if (children.length)
      attributes.children = children.length === 1 ? children[0] : children;
    if (node.name === null) return runtime.jsx(runtime.Fragment, attributes);
    // JSX treats lowercase and custom-element names as intrinsic tags. Dotted
    // names still refer to authored components, including lowercase namespaces.
    if (
      !node.name.includes(".") &&
      (/^[a-z]/.test(node.name) || node.name.includes("-"))
    )
      return runtime.jsx(
        props.components?.[node.name] ?? node.name,
        attributes,
      );
    let binding: ReviewDocumentExport = bindings;
    for (const part of node.name.split("."))
      binding = isObjectValue(binding)
        ? Object.entries(binding).find(([name]) => name === part)?.[1]
        : undefined;
    const type = isPublishAuditComponent(binding)
      ? binding
      : (props.components?.[node.name] ?? node.name);
    return runtime.jsx(type, attributes);
  };
  return syntax.body.map(visit);
}
