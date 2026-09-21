/** The document projection and the React wrappers share these render gates. */
export interface TutorialRenderContext {
  tutorial: boolean;
  softwareMapEnabled: boolean;
}

export function tutorialFeatureVisible(
  context: TutorialRenderContext,
): boolean {
  return context.tutorial && context.softwareMapEnabled;
}

export function tutorialViewVisible(
  context: TutorialRenderContext,
  view: string,
): boolean {
  return context.tutorial && (view !== "map" || context.softwareMapEnabled);
}
