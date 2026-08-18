import ts from "typescript";

import {
  type ReviewMdxDocument,
  estreeNodeRange,
  findCallExpressions,
} from "./review-mdx-ast";

export interface StaticSoftwareMapElement {
  path: string;
  type:
    | "person"
    | "softwareSystem"
    | "container"
    | "dataStore"
    | "component"
    | "codeElement";
  children: string[];
  external: boolean;
  coverage?: StaticSoftwareMapCoverage;
}

interface StaticSoftwareMapPendingRelationship {
  from: string;
  to: string;
  scopePath?: string;
}

export interface StaticSoftwareMapRelationship {
  from: string;
  to: string;
}

export interface StaticSoftwareMapCoverageFile {
  path: string;
  ranges: Array<{ fromLine: number; toLine: number }>;
}

export interface StaticSoftwareMapCoverage {
  files: StaticSoftwareMapCoverageFile[];
  globs: string[];
}

export interface StaticSoftwareMapCoverageClaim extends StaticSoftwareMapCoverage {
  path: string;
}

export interface StaticSoftwareMapConnectivityModel {
  elements: StaticSoftwareMapElement[];
  relationships: StaticSoftwareMapRelationship[];
  coverageClaims: StaticSoftwareMapCoverageClaim[];
}

export function collectSoftwareMapConnectivityWarnings(
  source: string,
  options: {
    // Pass for MDX sources so the model call is located in the document's
    // esm estree; omit for plain TypeScript artifacts.
    document?: ReviewMdxDocument;
  } = {},
) {
  const model = collectSoftwareMapConnectivityModel(source, options.document);
  if (!model) return [];

  return collectSoftwareMapConnectivityWarningsForModel({
    elements: model.elements,
    relationships: model.relationships,
  });
}

export function collectSoftwareMapConnectivityModel(
  source: string,
  document?: ReviewMdxDocument,
): StaticSoftwareMapConnectivityModel | null {
  const modelObject = parseSoftwareMapModelObject(source, document);
  if (!modelObject) return null;

  const elements: StaticSoftwareMapElement[] = [];
  const pendingRelationships: StaticSoftwareMapPendingRelationship[] = [];
  const stringBindings = collectStaticStringBindings(source);
  collectStaticSoftwareMapRelationships(
    modelObject,
    undefined,
    pendingRelationships,
  );
  collectStaticSoftwareMapCollection({
    collection: getObjectPropertyValue(modelObject, "people"),
    type: "person",
    parentPath: undefined,
    elements,
    pendingRelationships,
    stringBindings,
  });
  collectStaticSoftwareMapCollection({
    collection: getObjectPropertyValue(modelObject, "systems"),
    type: "softwareSystem",
    parentPath: undefined,
    elements,
    pendingRelationships,
    stringBindings,
  });

  const elementsByPath = new Map(
    elements.map((element) => [element.path, element]),
  );
  const relationships = pendingRelationships.flatMap((relationship) => {
    const from = resolveStaticSoftwareMapEndpoint(
      relationship.from,
      relationship.scopePath,
      elementsByPath,
    );
    const to = resolveStaticSoftwareMapEndpoint(
      relationship.to,
      relationship.scopePath,
      elementsByPath,
    );
    return from && to ? [{ from, to }] : [];
  });

  return {
    elements,
    relationships,
    coverageClaims: elements.flatMap((element) =>
      element.coverage ? [{ path: element.path, ...element.coverage }] : [],
    ),
  };
}

function collectSoftwareMapConnectivityWarningsForModel({
  elements,
  relationships,
}: {
  elements: StaticSoftwareMapElement[];
  relationships: StaticSoftwareMapRelationship[];
}) {
  const elementsByPath = new Map(
    elements.map((element) => [element.path, element]),
  );
  const warnings: string[] = [];

  for (const parent of elements) {
    if (
      parent.type !== "softwareSystem" &&
      parent.type !== "container" &&
      parent.type !== "dataStore" &&
      parent.type !== "component"
    ) {
      continue;
    }
    if (parent.children.length <= 1) continue;

    const disconnectedChildren = parent.children.filter((childPath) => {
      const child = elementsByPath.get(childPath);
      return (
        child &&
        !child.external &&
        !hasStaticSoftwareMapCrossSubtreeRelationship(child.path, relationships)
      );
    });
    if (parent.type === "component" && disconnectedChildren.length > 0) {
      warnings.push(
        `SoftwareMap connectivity: "${parent.path}" has ${disconnectedChildren.length} code element(s) with no relationship to any element outside themselves; they may be orphaned or under-connected.`,
      );
      continue;
    }

    for (const childPath of parent.children) {
      const child = elementsByPath.get(childPath);
      if (!child || child.external) continue;
      if (
        hasStaticSoftwareMapCrossSubtreeRelationship(child.path, relationships)
      ) {
        continue;
      }
      warnings.push(
        `SoftwareMap connectivity: "${child.path}" has no relationship to any element outside its own subtree; it may be orphaned or under-connected.`,
      );
    }
  }

  return warnings;
}

// Locate the single defineSoftwareModel/defineSoftwareMap call by AST, never
// by scanning raw text — a fenced example or comment quoting the call name
// must not affect extraction. Two source kinds arrive here:
// - MDX review documents (pass the parsed `document`): the call lives in an
//   `export` block, so it is found in the esm estree and its exact source
//   span is re-parsed with TypeScript for the walkers below.
// - Plain TypeScript artifacts (software-map.ts): the whole file parses as
//   TypeScript directly, and the call is found in that tree.
function parseSoftwareMapModelObject(
  source: string,
  document?: ReviewMdxDocument,
): ts.ObjectLiteralExpression | null {
  if (document) {
    if (document.parseError) return null;
    const calls = document.esmPrograms.flatMap((program) => [
      ...findCallExpressions(program, "defineSoftwareModel"),
      ...findCallExpressions(program, "defineSoftwareMap"),
    ]);
    if (calls.length !== 1) return null;
    const range = estreeNodeRange(calls[0]);
    if (!range) return null;
    return softwareMapModelObjectFromTsSource(
      `(${source.slice(range.start, range.end)})`,
      { requireSingleCall: false },
    );
  }
  return softwareMapModelObjectFromTsSource(source, {
    requireSingleCall: true,
  });
}

function softwareMapModelObjectFromTsSource(
  tsSource: string,
  { requireSingleCall }: { requireSingleCall: boolean },
): ts.ObjectLiteralExpression | null {
  const sourceFile = ts.createSourceFile(
    "review-software-map-model.tsx",
    tsSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const parseDiagnostics =
    (
      sourceFile as ts.SourceFile & {
        parseDiagnostics?: readonly ts.Diagnostic[];
      }
    ).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) return null;

  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      isDefineSoftwareMapCallName(node.expression.text)
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (requireSingleCall && calls.length !== 1) return null;
  const callExpression = calls[0];
  if (
    !callExpression ||
    callExpression.arguments.length !== 1 ||
    !ts.isObjectLiteralExpression(callExpression.arguments[0])
  ) {
    return null;
  }
  return callExpression.arguments[0];
}

function isDefineSoftwareMapCallName(value: string) {
  return value === "defineSoftwareModel" || value === "defineSoftwareMap";
}

function collectStaticSoftwareMapCollection({
  collection,
  type,
  parentPath,
  elements,
  pendingRelationships,
  stringBindings,
}: {
  collection: ts.Expression | undefined;
  type: StaticSoftwareMapElement["type"];
  parentPath: string | undefined;
  elements: StaticSoftwareMapElement[];
  pendingRelationships: StaticSoftwareMapPendingRelationship[];
  stringBindings: ReadonlyMap<string, string>;
}) {
  if (!collection || !ts.isObjectLiteralExpression(collection)) return;
  for (const property of collection.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const id = propertyNameText(property.name);
    if (!id) continue;
    const path = parentPath ? `${parentPath}.${id}` : id;
    const object = ts.isObjectLiteralExpression(property.initializer)
      ? property.initializer
      : undefined;
    const element: StaticSoftwareMapElement = {
      path,
      type,
      children: [],
      external: object ? booleanObjectProperty(object, "external") : false,
      coverage: object
        ? staticSoftwareMapCoverage(object, stringBindings)
        : undefined,
    };
    elements.push(element);
    if (!object) continue;
    collectStaticSoftwareMapRelationships(object, path, pendingRelationships);

    if (type === "softwareSystem") {
      element.children = [
        ...collectStaticSoftwareMapChildPaths(object, "containers", path),
        ...collectStaticSoftwareMapChildPaths(object, "dataStores", path),
      ];
      collectStaticSoftwareMapCollection({
        collection: getObjectPropertyValue(object, "containers"),
        type: "container",
        parentPath: path,
        elements,
        pendingRelationships,
        stringBindings,
      });
      collectStaticSoftwareMapCollection({
        collection: getObjectPropertyValue(object, "dataStores"),
        type: "dataStore",
        parentPath: path,
        elements,
        pendingRelationships,
        stringBindings,
      });
    } else if (type === "container" || type === "dataStore") {
      element.children = collectStaticSoftwareMapChildPaths(
        object,
        "components",
        path,
      );
      collectStaticSoftwareMapCollection({
        collection: getObjectPropertyValue(object, "components"),
        type: "component",
        parentPath: path,
        elements,
        pendingRelationships,
        stringBindings,
      });
    } else if (type === "component") {
      element.children = collectStaticSoftwareMapChildPaths(
        object,
        "codeElements",
        path,
      );
      collectStaticSoftwareMapCollection({
        collection: getObjectPropertyValue(object, "codeElements"),
        type: "codeElement",
        parentPath: path,
        elements,
        pendingRelationships,
        stringBindings,
      });
    }
  }
}

function staticSoftwareMapCoverage(
  object: ts.ObjectLiteralExpression,
  stringBindings: ReadonlyMap<string, string>,
): StaticSoftwareMapCoverage | undefined {
  const coverage = getObjectPropertyValue(object, "coverage");
  if (!coverage || !ts.isObjectLiteralExpression(coverage)) return undefined;
  const files = staticSoftwareMapCoverageFiles(
    getObjectPropertyValue(coverage, "files"),
    stringBindings,
  );
  const globs = staticStringArrayValue(
    getObjectPropertyValue(coverage, "globs"),
    stringBindings,
  );
  return files.length > 0 || globs.length > 0 ? { files, globs } : undefined;
}

function staticSoftwareMapCoverageFiles(
  expression: ts.Expression | undefined,
  stringBindings: ReadonlyMap<string, string>,
): StaticSoftwareMapCoverageFile[] {
  if (!expression || !ts.isArrayLiteralExpression(expression)) return [];
  return expression.elements.flatMap((element) => {
    if (ts.isSpreadElement(element)) return [];
    const path = staticStringExpressionValue(element, stringBindings);
    if (path) return [{ path, ranges: [] }];
    if (!ts.isObjectLiteralExpression(element)) return [];
    const filePath = staticStringExpressionValue(
      getObjectPropertyValue(element, "path"),
      stringBindings,
    );
    if (!filePath) return [];
    return [
      {
        path: filePath,
        ranges: staticSoftwareMapRanges(
          getObjectPropertyValue(element, "ranges"),
        ),
      },
    ];
  });
}

function staticSoftwareMapRanges(expression: ts.Expression | undefined) {
  if (!expression || !ts.isArrayLiteralExpression(expression)) return [];
  return expression.elements.flatMap((element) => {
    if (!ts.isObjectLiteralExpression(element)) return [];
    const fromLine = numberObjectProperty(element, "fromLine");
    const toLine = numberObjectProperty(element, "toLine");
    return fromLine && toLine ? [{ fromLine, toLine }] : [];
  });
}

function collectStaticSoftwareMapChildPaths(
  object: ts.ObjectLiteralExpression,
  property: string,
  parentPath: string,
) {
  const collection = getObjectPropertyValue(object, property);
  if (!collection || !ts.isObjectLiteralExpression(collection)) return [];
  return collection.properties.flatMap((child) => {
    if (!ts.isPropertyAssignment(child)) return [];
    const id = propertyNameText(child.name);
    return id ? [`${parentPath}.${id}`] : [];
  });
}

function collectStaticSoftwareMapRelationships(
  object: ts.ObjectLiteralExpression,
  scopePath: string | undefined,
  pendingRelationships: StaticSoftwareMapPendingRelationship[],
) {
  const relationships = getObjectPropertyValue(object, "relationships");
  if (!relationships || !ts.isArrayLiteralExpression(relationships)) return;
  for (const element of relationships.elements) {
    if (!ts.isObjectLiteralExpression(element)) continue;
    const from = stringObjectProperty(element, "from");
    const to = stringObjectProperty(element, "to");
    if (from && to) pendingRelationships.push({ from, to, scopePath });
  }
}

function collectStaticStringBindings(source: string): Map<string, string> {
  const bindings = new Map<string, string>();
  const pattern =
    /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(["'`])((?:\\.|(?!\2)[\s\S])*?)\2\s*;/g;
  for (const match of source.matchAll(pattern)) {
    const [, name, quote, rawValue] = match;
    if (!name || !quote || rawValue === undefined) continue;
    const value =
      quote === "`"
        ? rawValue.replace(/\\`/g, "`")
        : rawValue.replace(new RegExp(`\\\\${quote}`, "g"), quote);
    bindings.set(name, value);
  }
  return bindings;
}

function staticStringExpressionValue(
  expression: ts.Expression | undefined,
  stringBindings: ReadonlyMap<string, string>,
) {
  if (!expression) return undefined;
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return expression.text;
  }
  if (ts.isIdentifier(expression)) {
    return stringBindings.get(expression.text);
  }
  return undefined;
}

function resolveStaticSoftwareMapEndpoint(
  endpoint: string,
  scopePath: string | undefined,
  elementsByPath: ReadonlyMap<string, StaticSoftwareMapElement>,
) {
  const candidates: string[] = [];
  if (scopePath && endpoint === ".") candidates.push(scopePath);
  if (scopePath && endpoint !== ".") {
    candidates.push(`${scopePath}.${endpoint}`);
    const parentPath = softwareMapParentPath(scopePath);
    if (parentPath) candidates.push(`${parentPath}.${endpoint}`);
  }
  candidates.push(endpoint);
  return candidates.find((candidate) => elementsByPath.has(candidate));
}

function hasStaticSoftwareMapCrossSubtreeRelationship(
  path: string,
  relationships: readonly StaticSoftwareMapRelationship[],
) {
  return relationships.some(
    (relationship) =>
      (isSoftwareMapPathAtOrUnder(relationship.from, path) &&
        !isSoftwareMapPathAtOrUnder(relationship.to, path)) ||
      (isSoftwareMapPathAtOrUnder(relationship.to, path) &&
        !isSoftwareMapPathAtOrUnder(relationship.from, path)),
  );
}

function getObjectPropertyValue(
  object: ts.ObjectLiteralExpression,
  property: string,
) {
  const match = object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      propertyNameText(candidate.name) === property,
  );
  return match?.initializer;
}

function stringObjectProperty(
  object: ts.ObjectLiteralExpression,
  property: string,
) {
  const value = getObjectPropertyValue(object, property);
  return value &&
    (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))
    ? value.text
    : undefined;
}

function booleanObjectProperty(
  object: ts.ObjectLiteralExpression,
  property: string,
) {
  const value = getObjectPropertyValue(object, property);
  return value?.kind === ts.SyntaxKind.TrueKeyword;
}

function numberObjectProperty(
  object: ts.ObjectLiteralExpression,
  property: string,
) {
  const value = getObjectPropertyValue(object, property);
  return value && ts.isNumericLiteral(value) ? Number(value.text) : undefined;
}

function staticStringArrayValue(
  expression: ts.Expression | undefined,
  stringBindings: ReadonlyMap<string, string>,
) {
  if (!expression || !ts.isArrayLiteralExpression(expression)) return [];
  return expression.elements.flatMap((element) => {
    if (ts.isSpreadElement(element)) return [];
    const value = staticStringExpressionValue(element, stringBindings);
    return value ? [value] : [];
  });
}

function propertyNameText(name: ts.PropertyName) {
  return ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
    ? name.text
    : undefined;
}

function softwareMapParentPath(path: string) {
  const lastDot = path.lastIndexOf(".");
  return lastDot === -1 ? undefined : path.slice(0, lastDot);
}

function isSoftwareMapPathAtOrUnder(path: string, ancestorPath: string) {
  return path === ancestorPath || path.startsWith(`${ancestorPath}.`);
}
