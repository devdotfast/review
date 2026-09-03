import type { NormalizedSoftwareModel } from "./model";
import type {
  SoftwareMapCoverageClaim,
  SoftwareMapResolvedDataInput,
} from "./SoftwareMap";

const SOFTWARE_MAP_RESOLVED_DATA_VERSION = "resolved-data:v2";

function createSoftwareMapSignature() {
  let hash = 0x811c9dc5;
  const addText = (text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0x1f;
    hash = Math.imul(hash, 0x01000193);
  };
  return {
    add(value: string | number) {
      const text = String(value);
      addText(`${text.length}:${text}`);
    },
    value(prefix: string, size: number) {
      return `${prefix}:${size}:${(hash >>> 0).toString(36)}`;
    },
  };
}

export function softwareMapModelKey({
  model,
  view,
  showModifiedOnly,
  showRemovedNodes,
}: {
  model: NormalizedSoftwareModel | undefined;
  view: string | undefined;
  showModifiedOnly: boolean;
  showRemovedNodes: boolean;
}) {
  if (!model) return view ?? "";
  const signature = createSoftwareMapSignature();
  signature.add(view ?? "");
  signature.add(showModifiedOnly ? "modified-only" : "all");
  signature.add(showRemovedNodes ? "with-removed" : "without-removed");
  for (const element of model.elements) {
    signature.add(element.path);
    signature.add(element.type);
    signature.add(element.dataStoreKind ?? "");
    signature.add(element.parentPath ?? "");
    for (const child of element.children) {
      signature.add(child);
    }
  }
  for (const relationship of model.relationships) {
    signature.add(relationship.id);
    signature.add(relationship.from);
    signature.add(relationship.to);
    signature.add(relationship.kind);
    signature.add(
      relationship.kind === "semantic" ? (relationship.semanticKind ?? "") : "",
    );
  }
  return signature.value(
    "model",
    model.elements.length + model.relationships.length,
  );
}

export function softwareMapResolvedDataInputKey(
  input: SoftwareMapResolvedDataInput,
) {
  const signature = createSoftwareMapSignature();
  signature.add(SOFTWARE_MAP_RESOLVED_DATA_VERSION);
  signature.add("code-elements");
  for (const codeElement of input.codeElements) {
    signature.add(codeElement.path);
    signature.add(codeElement.label);
    signature.add(codeElement.description ?? "");
    signature.add(codeElement.changeStatus ?? "");
    for (const range of codeElement.sourceRanges ?? []) {
      signature.add(range.file);
      signature.add(range.fromLine);
      signature.add(range.toLine);
    }
  }
  signature.add("coverage");
  for (const claim of input.coverageClaims) {
    addSoftwareMapCoverageClaimSignature(signature, claim);
  }
  return signature.value(
    "resolved",
    input.codeElements.length + input.coverageClaims.length,
  );
}

function addSoftwareMapCoverageClaimSignature(
  signature: ReturnType<typeof createSoftwareMapSignature>,
  claim: SoftwareMapCoverageClaim,
) {
  signature.add(claim.path);
  for (const file of claim.files ?? []) {
    signature.add(file.path);
    for (const range of file.ranges ?? []) {
      signature.add(range.fromLine);
      signature.add(range.toLine);
    }
  }
  for (const glob of claim.globs ?? []) {
    signature.add(glob);
  }
}

export function softwareMapResolvedDataInputHasWork(
  input: SoftwareMapResolvedDataInput,
) {
  return input.codeElements.length > 0 || input.coverageClaims.length > 0;
}

export function softwareMapResolvedDataInputForModel(
  model: NormalizedSoftwareModel,
  _options: { expandedElementPaths?: ReadonlySet<string> } = {},
): SoftwareMapResolvedDataInput {
  return {
    codeElements: createSoftwareMapCodeElements(model),
    coverageClaims: createSoftwareMapCoverageClaims(model),
  };
}

export function shouldApplySoftwareMapModifiedOnly({
  showModifiedOnly,
  resolvedDataReady,
  resolvedDataInput,
}: {
  showModifiedOnly: boolean;
  resolvedDataReady: boolean;
  resolvedDataInput: SoftwareMapResolvedDataInput | null;
}) {
  return (
    showModifiedOnly &&
    resolvedDataReady &&
    Boolean(
      resolvedDataInput &&
      softwareMapResolvedDataInputHasWork(resolvedDataInput),
    )
  );
}

export function createSoftwareMapCodeElements(model: NormalizedSoftwareModel) {
  return model.elements.flatMap((element) =>
    element.type === "codeElement"
      ? [
          {
            path: element.path,
            label: element.label,
            description: element.description,
            changeStatus: element.changeStatus,
            sourceRanges: element.sourceRanges,
          },
        ]
      : [],
  );
}

function createSoftwareMapCoverageClaims(
  model: NormalizedSoftwareModel,
): SoftwareMapCoverageClaim[] {
  return model.elements.flatMap((element) =>
    element.coverage
      ? [
          {
            path: element.path,
            files: element.coverage.files.map((file) => ({
              path: file.path,
              ranges: file.ranges,
            })),
            globs: element.coverage.globs,
          },
        ]
      : [],
  );
}
