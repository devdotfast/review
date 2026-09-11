/** Authoring names shared by semantic checking and the disposable runtime.
 * Keep this module independent of the TypeScript compiler. */
export const authoringSpecifiers = [
  "virtual:progressive-review-authoring",
  "@dev.fast/review/authoring",
] as const;

export function isAuthoringSpecifier(specifier: string): boolean {
  return authoringSpecifiers.some((candidate) => candidate === specifier);
}

export const sessionHelperNames = [
  "defineActors",
  "defineAnchors",
  "defineSoftwareActors",
  "defineSoftwareStores",
  "defineStores",
] as const;

export const authoringHelperNames = [
  "calls",
  ...sessionHelperNames,
  "defineSoftwareModel",
  "__reviewDefinitionsReady",
] as const;

export function reviewHelperImports(
  existingBindings: ReadonlySet<string> = new Set(),
  specifier: string = authoringSpecifiers[0],
): string {
  const helpers = authoringHelperNames.filter(
    (helper) => !existingBindings.has(helper),
  );

  return helpers.length
    ? `import { ${helpers.join(", ")} } from ${JSON.stringify(specifier)};`
    : "";
}
