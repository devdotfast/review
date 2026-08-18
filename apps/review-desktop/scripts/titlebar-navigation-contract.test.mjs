import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const reviewTitlebar = readFileSync(
  new URL(
    "../code-oss/src/vs/review/browser/parts/reviewTitlebarPart.ts",
    import.meta.url,
  ),
  "utf8",
);

const reviewConfiguration = readFileSync(
  new URL(
    "../code-oss/src/vs/review/common/reviewConfigurationDefaults.ts",
    import.meta.url,
  ),
  "utf8",
);

const reviewMain = readFileSync(
  new URL(
    "../code-oss/src/vs/review/electron-browser/review.main.ts",
    import.meta.url,
  ),
  "utf8",
);

const commandCenterControl = readFileSync(
  new URL(
    "../code-oss/src/vs/workbench/browser/parts/titlebar/commandCenterControl.ts",
    import.meta.url,
  ),
  "utf8",
);

const editorActions = readFileSync(
  new URL(
    "../code-oss/src/vs/workbench/browser/parts/editor/editorActions.ts",
    import.meta.url,
  ),
  "utf8",
);

test("Review mounts VS Code's native back and forward controls", () => {
  assert.match(
    reviewConfiguration,
    /'window\.title': 'Review',/,
    "mounting the native title control should preserve Review's window title",
  );
  assert.match(
    reviewConfiguration,
    /'workbench\.navigationControl\.enabled': true/,
    "Review's runtime configuration should keep navigation controls enabled",
  );
  assert.match(
    reviewMain,
    /new ReviewConfigurationService\([\s\S]*?\{ defaultOverrides: reviewAgentsWindowDefaultOverrides \}\)/,
    "Review's navigation defaults must survive Review configuration initialization",
  );

  assert.match(
    reviewTitlebar,
    /createInstance\(\s*CommandCenterControl,/,
    "Review should mount VS Code's native titlebar control",
  );
  assert.doesNotMatch(
    reviewTitlebar,
    /workbench\.action\.navigate(?:Back|Forward)/,
    "Review must not recreate or manually dispatch native navigation actions",
  );
  assert.doesNotMatch(
    reviewTitlebar,
    /review-title\b/,
    "the titlebar carries no product label; the branding lives in the macOS application menu",
  );

  for (const [action, icon] of [
    ["NavigateBackwardsAction", "arrowLeft"],
    ["NavigateForwardAction", "arrowRight"],
  ]) {
    const definition = editorActions.match(
      new RegExp(`export class ${action}[\\s\\S]*?\\n}`),
    )?.[0];
    assert.ok(definition, `expected ${action}`);
    assert.match(definition, new RegExp(`icon: Codicon\\.${icon}`));
    assert.match(definition, /id: MenuId\.CommandCenter/);
    assert.match(
      definition,
      /config\.workbench\.navigationControl\.enabled/,
    );
  }
});

test("the native control can omit the command launcher without hiding navigation", () => {
  const centerMenuItem = commandCenterControl.match(
    /MenuRegistry\.appendMenuItem\(MenuId\.CommandCenter, \{[\s\S]*?submenu: MenuId\.CommandCenterCenter,[\s\S]*?\n\}\);/,
  )?.[0];

  assert.ok(centerMenuItem, "expected the native command-center menu item");
  assert.match(centerMenuItem, /config\.window\.commandCenter/);
  assert.match(reviewConfiguration, /'window\.commandCenter': false,/);
});
