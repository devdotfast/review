import {
  type JsonValue,
  isJsonObject,
  jsonArray,
  jsonProperty,
  jsonString,
} from "@dev.fast/whiteboard-protocol";

import type { WhiteboardSession } from "../host/whiteboard-session";
import {
  forgetWhiteboardUiState,
  readWhiteboardUiState,
  writeWhiteboardUiState,
} from "../whiteboard-ui-state";
import { isInlineC4Expandable } from "./c4-projection";
import type { NormalizedSoftwareModel } from "./model";

export interface SoftwareMapNavigationState {
  modelKey: string | undefined;
  expandedNodeIds: string[];
  selectedNodeId: string | null;
  expanded: boolean;
}

const softwareMapNavigationStateByKey = new Map<
  string,
  SoftwareMapNavigationState
>();

export function softwareMapNavigationKey({
  title,
  view,
  placeholderLabel = "Software map",
}: {
  title?: string;
  view?: string;
  placeholderLabel?: string;
}) {
  return [title ?? "", view ?? "", placeholderLabel].join("\u001f");
}

export function softwareMapAncestorPaths(path: string): string[] {
  const parts = path.split(".");
  const ancestors: string[] = [];

  for (let index = 1; index < parts.length; index += 1) {
    ancestors.push(parts.slice(0, index).join("."));
  }

  return ancestors;
}

function defaultSoftwareMapNavigationState(
  modelKey: string | undefined,
): SoftwareMapNavigationState {
  return {
    modelKey,
    expandedNodeIds: [],
    selectedNodeId: null,
    expanded: false,
  };
}

function cachedSoftwareMapNavigationState(
  session: WhiteboardSession,
  key: string,
) {
  return (
    softwareMapNavigationStateByKey.get(
      softwareMapNavigationStorageKey(session, key),
    ) ?? readStoredSoftwareMapNavigationState(session, key)
  );
}

export function hasStoredSoftwareMapNavigationState(
  session: WhiteboardSession,
  key: string,
  modelKey: string | undefined,
) {
  return cachedSoftwareMapNavigationState(session, key)?.modelKey === modelKey;
}

export function restoreSoftwareMapNavigationState(
  session: WhiteboardSession,
  key: string,
  modelKey: string | undefined,
): SoftwareMapNavigationState {
  const cached = cachedSoftwareMapNavigationState(session, key);

  if (!cached || cached.modelKey !== modelKey) {
    return defaultSoftwareMapNavigationState(modelKey);
  }

  return {
    modelKey,
    expandedNodeIds: [...cached.expandedNodeIds],
    selectedNodeId: cached.selectedNodeId,
    expanded: cached.expanded,
  };
}

export function initialSoftwareMapExpandedNodeIds(
  model: NormalizedSoftwareModel | null | undefined,
): Set<string> {
  return new Set(
    model?.elements
      .filter(
        (element) =>
          element.type !== "component" && isInlineC4Expandable(element),
      )
      .map((element) => element.path) ?? [],
  );
}

export function seedSoftwareMapDefaultExpandedNodeIds(input: {
  expandedNodeIds: ReadonlySet<string>;
  model: NormalizedSoftwareModel | null | undefined;
  defaultExpansionActive: boolean;
}): Set<string> {
  if (!input.defaultExpansionActive) {
    return new Set(input.expandedNodeIds);
  }

  const expandedNodeIds = new Set(input.expandedNodeIds);

  for (const path of initialSoftwareMapExpandedNodeIds(input.model)) {
    expandedNodeIds.add(path);
  }

  return expandedNodeIds;
}

export function rememberSoftwareMapNavigationState(
  session: WhiteboardSession,
  key: string,
  state: SoftwareMapNavigationState,
) {
  softwareMapNavigationStateByKey.set(
    softwareMapNavigationStorageKey(session, key),
    {
      ...state,
      expandedNodeIds: [...state.expandedNodeIds],
    },
  );
  writeStoredSoftwareMapNavigationState(session, key, state);
}

export function clearSoftwareMapNavigationStateForTests(
  session: WhiteboardSession,
) {
  softwareMapNavigationStateByKey.clear();

  if (typeof window !== "undefined") {
    forgetWhiteboardUiState("window", (key) =>
      key.startsWith(session.storageKey("software-map-navigation")),
    );
  }
}

function softwareMapNavigationStorageKey(
  session: WhiteboardSession,
  key: string,
) {
  return session.storageKey("software-map-navigation", key);
}

function readStoredSoftwareMapNavigationState(
  session: WhiteboardSession,
  key: string,
): SoftwareMapNavigationState | null {
  const parsed = readWhiteboardUiState<JsonValue>(
    "window",
    softwareMapNavigationStorageKey(session, key),
  );

  if (!isJsonObject(parsed)) return null;

  return {
    modelKey: jsonString(jsonProperty(parsed, "modelKey")),
    expandedNodeIds: (jsonArray(jsonProperty(parsed, "expandedNodeIds")) ?? [])
      .map(jsonString)
      .filter((entry): entry is string => entry !== undefined),
    selectedNodeId: jsonString(jsonProperty(parsed, "selectedNodeId")) ?? null,
    expanded: jsonProperty(parsed, "expanded") === true,
  };
}

function writeStoredSoftwareMapNavigationState(
  session: WhiteboardSession,
  key: string,
  state: SoftwareMapNavigationState,
) {
  writeWhiteboardUiState(
    "window",
    softwareMapNavigationStorageKey(session, key),
    {
      ...state,
      expandedNodeIds: [...state.expandedNodeIds],
    },
  );
}
