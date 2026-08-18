import { z } from "zod";

import {
  type CallStackDiffProps,
  callStackDiffPropsSchema,
  reviewAuthoringPropsSchemas,
} from "./authoring";

// Publish-time element audit. The validation runtime's React substitute does
// not render: `jsx` builds cheap element records, and the audit invokes the
// document component once so every element the document creates exists as a
// record. Each record whose type is a known authoring component is parsed
// with that component's props schema, and the lens containment rules the app
// applies with Children.forEach are enforced structurally. This is the layer
// that makes "publishes clean, renders blank" impossible for schema-visible
// mistakes: the app never sees an element the audit did not see first.

const ELEMENT_MARKER = "__reviewPublishElement";
const FRAGMENT = Symbol.for("react.fragment");

export interface PublishAuditElement {
  [ELEMENT_MARKER]: true;
  type: unknown;
  props: Record<string, unknown>;
  key: unknown;
}

type AuthoringComponentName = keyof typeof reviewAuthoringPropsSchemas;

function isAuditElement(value: unknown): value is PublishAuditElement {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[ELEMENT_MARKER] === true
  );
}

function makeElement(
  type: unknown,
  props: Record<string, unknown> | null | undefined,
  key: unknown,
): PublishAuditElement {
  return { [ELEMENT_MARKER]: true, type, props: props ?? {}, key };
}

// Matches React.Children semantics closely enough for authored documents:
// arrays flatten recursively; null, undefined, and booleans disappear.
// Fragments do NOT flatten — React.Children treats a fragment as one child,
// and the lens parsers in the app rely on that.
function flattenChildren(children: unknown): unknown[] {
  if (children === null || children === undefined) return [];
  if (typeof children === "boolean") return [];
  if (Array.isArray(children)) return children.flatMap(flattenChildren);
  return [children];
}

export function createPublishValidationReact(): Record<string, unknown> {
  const noop = () => undefined;
  const identity = (value: unknown) => value;
  // A plain function keeps `class X extends Component` working: unlike an
  // arrow function it has a prototype, and the stub is never instantiated.
  function StubComponent(): void {}
  const jsx = (type: unknown, props?: Record<string, unknown>, key?: unknown) =>
    makeElement(type, props, key);
  const createElement = (
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ) =>
    makeElement(
      type,
      children.length > 0
        ? { ...props, children: children.length === 1 ? children[0] : children }
        : (props ?? {}),
      props?.key,
    );
  const react: Record<string, unknown> = {
    Children: {
      map: (
        children: unknown,
        fn: (child: unknown, index: number) => unknown,
      ) => flattenChildren(children).map(fn),
      forEach: (
        children: unknown,
        fn: (child: unknown, index: number) => void,
      ) => {
        flattenChildren(children).forEach(fn);
      },
      count: (children: unknown) => flattenChildren(children).length,
      only: (children: unknown) => {
        const flat = flattenChildren(children);
        if (flat.length !== 1 || !isAuditElement(flat[0])) {
          throw new Error("React.Children.only expected a single child.");
        }
        return flat[0];
      },
      toArray: (children: unknown) => flattenChildren(children),
    },
    Component: StubComponent,
    Fragment: FRAGMENT,
    Profiler: Symbol.for("react.profiler"),
    PureComponent: StubComponent,
    StrictMode: Symbol.for("react.strict_mode"),
    Suspense: Symbol.for("react.suspense"),
    act: noop,
    cache: identity,
    captureOwnerStack: () => null,
    cloneElement: (
      element: PublishAuditElement,
      props?: Record<string, unknown>,
      ...children: unknown[]
    ) =>
      makeElement(
        element.type,
        {
          ...element.props,
          ...props,
          ...(children.length > 0
            ? { children: children.length === 1 ? children[0] : children }
            : {}),
        },
        props && "key" in props ? props.key : element.key,
      ),
    createContext: () => ({ Provider: noop, Consumer: noop }),
    createElement,
    createRef: () => ({ current: null }),
    forwardRef: identity,
    isValidElement: isAuditElement,
    lazy: identity,
    memo: identity,
    startTransition: (callback?: () => void) => callback?.(),
    use: noop,
    useActionState: noop,
    useCallback: identity,
    useContext: noop,
    useDebugValue: noop,
    useDeferredValue: identity,
    useEffect: noop,
    useEffectEvent: identity,
    useId: () => "publish-validation",
    useImperativeHandle: noop,
    useInsertionEffect: noop,
    useLayoutEffect: noop,
    useMemo: noop,
    useOptimistic: noop,
    useReducer: noop,
    useRef: () => ({ current: null }),
    useState: noop,
    useSyncExternalStore: noop,
    useTransition: noop,
    version: "0.0.0-publish-validation",
    jsx,
    jsxs: jsx,
    jsxDEV: jsx,
  };
  react.React = react;
  return react;
}

export function auditReviewDocumentComponent(input: {
  Component: unknown;
  reportError: (message: string) => void;
  // Publish checks every CallStackDiff's -/+ rows against the change's
  // deleted and added lines; the audit is the one walk that sees each
  // element, so it hands the parsed props to the evaluation.
  collectCallStackDiff?: (props: CallStackDiffProps) => void;
}): void {
  if (typeof input.Component !== "function") return;
  const components = new Map<AuthoringComponentName, unknown>();
  const componentNames = new Map<unknown, AuthoringComponentName>();
  for (const name of Object.keys(
    reviewAuthoringPropsSchemas,
  ) as AuthoringComponentName[]) {
    const stub = () => null;
    Object.defineProperty(stub, "name", { value: name });
    components.set(name, stub);
    componentNames.set(stub, name);
  }

  let tree: unknown;
  try {
    tree = (input.Component as (props: unknown) => unknown)({
      components: Object.fromEntries(components),
    });
  } catch (error) {
    input.reportError(
      `Review document did not evaluate for validation: ${errorMessage(error)}`,
    );
    return;
  }

  const walk = (node: unknown, parentName: AuthoringComponentName | null) => {
    for (const child of flattenChildren(node)) {
      if (!isAuditElement(child)) continue;
      const name = componentNames.get(child.type) ?? null;
      if (name) {
        auditElement(
          child,
          name,
          parentName,
          componentNames,
          input.reportError,
        );
        if (name === "CallStackDiff" && input.collectCallStackDiff) {
          const parsed = callStackDiffPropsSchema.safeParse(child.props);
          if (parsed.success) input.collectCallStackDiff(parsed.data);
        }
        walk(child.props.children, name);
        continue;
      }
      if (typeof child.type === "function") {
        // Best-effort expansion of document-local components: MDX-generated
        // helpers are hook-free and expand; anything that throws under the
        // stub hooks is skipped, exactly as inert as it was before the audit.
        let rendered: unknown = null;
        try {
          rendered = (child.type as (props: unknown) => unknown)(child.props);
        } catch {
          rendered = null;
        }
        walk(rendered, null);
      }
      walk(child.props.children, null);
    }
  };
  walk(tree, null);
}

function auditElement(
  element: PublishAuditElement,
  name: AuthoringComponentName,
  parentName: AuthoringComponentName | null,
  componentNames: ReadonlyMap<unknown, AuthoringComponentName>,
  reportError: (message: string) => void,
): void {
  const schema: z.ZodType = reviewAuthoringPropsSchemas[name];
  const parsed = schema.safeParse(element.props);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join(".") : "props";
      reportError(`<${name}> ${path}: ${issue.message}`);
    }
  }

  const childNames = flattenChildren(element.props.children).flatMap((child) =>
    isAuditElement(child) ? [componentNames.get(child.type) ?? null] : [],
  );

  // Containment mirrors the app's Children.forEach parsers, which see only
  // direct children: an operation reached through a wrapper is dropped there,
  // so it is an error here.
  if (name === "DbUseCase" && parentName !== "DatabaseLens") {
    reportError(
      `<DbUseCase> must be a direct child of <DatabaseLens>; the app ignores it anywhere else.`,
    );
  }
  if ((name === "DbRead" || name === "DbWrite") && parentName !== "DbUseCase") {
    reportError(
      `<${name}> must be a direct child of <DbUseCase>; the app ignores it anywhere else.`,
    );
  }
  if (name === "DatabaseLens") {
    if (!childNames.includes("DbUseCase")) {
      reportError(`<DatabaseLens> must contain at least one <DbUseCase>.`);
    }
    const labels = new Set<string>();
    for (const child of flattenChildren(element.props.children)) {
      if (!isAuditElement(child)) continue;
      if (componentNames.get(child.type) !== "DbUseCase") continue;
      const label = child.props.label;
      if (typeof label !== "string") continue;
      if (labels.has(label)) {
        reportError(
          `<DbUseCase> label "${label}" must be unique within its <DatabaseLens>.`,
        );
      }
      labels.add(label);
    }
  }
  if (
    name === "DbUseCase" &&
    !childNames.some((child) => child === "DbRead" || child === "DbWrite")
  ) {
    reportError(`<DbUseCase> must contain at least one <DbRead> or <DbWrite>.`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
