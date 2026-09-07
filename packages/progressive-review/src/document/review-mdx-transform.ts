export function reviewHelperImports(
  existingBindings: ReadonlySet<string> = new Set(),
): string {
  const helpers = [
    "calls",
    "defineActors",
    "defineAnchors",
    "defineSoftwareActors",
    "defineSoftwareModel",
    "defineSoftwareStores",
    "defineStores",
    "__reviewDefinitionsReady",
  ].filter((helper) => !existingBindings.has(helper));
  return [
    `import {`,
    ...helpers.map((helper) => `  ${helper},`),
    `} from "virtual:progressive-review-authoring";`,
  ].join("\n");
}
