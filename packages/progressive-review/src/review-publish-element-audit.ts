import { z } from "zod";

import {
  type CallStackDiffProps,
  callStackDiffPropsSchema,
  reviewAuthoringPropsSchemas,
  traceQuotePropsSchema,
} from "./authoring";
import { errorMessage } from "./error-message";

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
  props: PublishValidationProps;
  key: unknown;
}

// The tree the audit walks: element records, text, and the values
// React.Children drops (booleans, null, undefined), nested in arrays.
export type PublishAuditNode =
  | PublishAuditElement
  | string
  | number
  | boolean
  | null
  | undefined
  | PublishAuditNode[];

export type PublishAuditComponent = (
  props: PublishValidationProps,
) => PublishAuditNode;

// Prop values as the audit reads and writes them: `children` is a node tree,
// `label` is a string, and `components` is the stub map handed to the
// document. Every other authored prop is opaque here; the component's zod
// schema parses it.
export type PublishValidationPropValue =
  | PublishAuditNode
  | Record<string, PublishAuditComponent>;

export interface PublishValidationProps {
  children?: PublishAuditNode;
  [prop: string]: PublishValidationPropValue;
}

type AuthoringComponentName = keyof typeof reviewAuthoringPropsSchemas;

function isAuditElement(value: PublishAuditNode): value is PublishAuditElement {
  if (typeof value !== "object" || value === null) return false;
  return (
    (ELEMENT_MARKER in value && value[ELEMENT_MARKER] === true) ||
    ("$$typeof" in value &&
      (value.$$typeof === Symbol.for("react.element") ||
        value.$$typeof === Symbol.for("react.transitional.element")))
  );
}

function makeElement(
  type: unknown,
  props: PublishValidationProps | null | undefined,
  key: unknown,
): PublishAuditElement {
  return { [ELEMENT_MARKER]: true, type, props: props ?? {}, key };
}

// Matches React.Children semantics closely enough for authored documents:
// arrays flatten recursively; null, undefined, and booleans disappear.
// Fragments do NOT flatten — React.Children treats a fragment as one child,
// and the lens parsers in the app rely on that.
function flattenChildren(children: PublishAuditNode): PublishAuditNode[] {
  if (children === null || children === undefined) return [];
  if (typeof children === "boolean") return [];
  if (Array.isArray(children)) return children.flatMap(flattenChildren);
  return [children];
}

// The React surface the validation runtime exposes. `React` points back at
// the object itself so `import React from "react"` sees the same members.
export interface PublishValidationReact extends PublishValidationReactMembers {
  React?: PublishValidationReact;
}

type PublishValidationReactMembers = ReturnType<
  typeof publishValidationReactMembers
>;

export function createPublishValidationReact(): PublishValidationReact {
  const react: PublishValidationReact = { ...publishValidationReactMembers() };
  react.React = react;
  return react;
}

function publishValidationReactMembers() {
  const noop = () => undefined;
  const identity = (value: unknown) => value;
  // A plain function keeps `class X extends Component` working: unlike an
  // arrow function it has a prototype, and the stub is never instantiated.
  function StubComponent(): void {}
  const jsx = (type: unknown, props?: PublishValidationProps, key?: unknown) =>
    makeElement(type, props, key);
  const createElement = (
    type: unknown,
    props?: PublishValidationProps | null,
    ...children: PublishAuditNode[]
  ) =>
    makeElement(
      type,
      children.length > 0
        ? { ...props, children: children.length === 1 ? children[0] : children }
        : (props ?? {}),
      props?.key,
    );
  return {
    Children: {
      map: (
        children: PublishAuditNode,
        fn: (child: PublishAuditNode, index: number) => PublishAuditNode,
      ) => flattenChildren(children).map(fn),
      forEach: (
        children: PublishAuditNode,
        fn: (child: PublishAuditNode, index: number) => void,
      ) => {
        flattenChildren(children).forEach(fn);
      },
      count: (children: PublishAuditNode) => flattenChildren(children).length,
      only: (children: PublishAuditNode) => {
        const flat = flattenChildren(children);
        if (flat.length !== 1 || !isAuditElement(flat[0])) {
          throw new Error("React.Children.only expected a single child.");
        }
        return flat[0];
      },
      toArray: (children: PublishAuditNode) => flattenChildren(children),
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
      props?: PublishValidationProps,
      ...children: PublishAuditNode[]
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
}

export interface PublishAuditTraceQuote {
  sessionId: string;
  trace?: string;
  event?: number;
  text: string;
}

export function extractAuditText(node: PublishAuditNode): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(extractAuditText).join("");
  }
  if (isAuditElement(node)) {
    return extractAuditText(node.props.children);
  }
  return "";
}

export function auditReviewDocumentComponent(input: {
  Component: unknown;
  reportError: (message: string) => void;
  // Publish checks every CallStackDiff's -/+ rows against the change's
  // deleted and added lines; the audit is the one walk that sees each
  // element, so it hands the parsed props to the evaluation.
  collectCallStackDiff?: (props: CallStackDiffProps) => void;
  collectTraceQuote?: (quote: PublishAuditTraceQuote) => void;
}): void {
  if (typeof input.Component !== "function") return;
  const components = new Map<AuthoringComponentName, PublishAuditComponent>();
  const componentNames = new Map<unknown, AuthoringComponentName>();
  for (const name of Object.keys(
    reviewAuthoringPropsSchemas,
  ) as AuthoringComponentName[]) {
    const stub = () => null;
    Object.defineProperty(stub, "name", { value: name });
    components.set(name, stub);
    componentNames.set(stub, name);
  }

  let tree: PublishAuditNode;
  try {
    // SAFETY: the document component is the bundle's default export, compiled
    // from MDX against this runtime's `jsx`; it takes a props record and
    // returns the element tree those calls built.
    tree = (input.Component as PublishAuditComponent)({
      components: Object.fromEntries(components),
    });
  } catch (error) {
    input.reportError(
      `Review document did not evaluate for validation: ${errorMessage(error)}`,
    );
    return;
  }

  const walk = (
    node: PublishAuditNode,
    parentName: AuthoringComponentName | null,
  ) => {
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
        if (name === "TraceQuote" && input.collectTraceQuote) {
          const parsed = traceQuotePropsSchema.safeParse(child.props);
          if (parsed.success) {
            const text = extractAuditText(child.props.children);
            input.collectTraceQuote({
              sessionId: parsed.data.sessionId,
              trace: parsed.data.trace,
              event: parsed.data.event,
              text,
            });
          }
        }
        walk(child.props.children, name);
        continue;
      }
      if (typeof child.type === "function") {
        // Best-effort expansion of document-local components: MDX-generated
        // helpers are hook-free and expand; anything that throws under the
        // stub hooks is skipped, exactly as inert as it was before the audit.
        let rendered: PublishAuditNode = null;
        try {
          // SAFETY: a function-typed element is a document-local component
          // compiled against this runtime; it renders to the same node tree.
          rendered = (child.type as PublishAuditComponent)(child.props);
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
