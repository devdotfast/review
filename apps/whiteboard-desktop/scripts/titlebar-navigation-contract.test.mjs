import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const whiteboardTitlebar = readFileSync(
  new URL(
    "../code-oss/src/vs/whiteboard/browser/parts/whiteboardTitlebarPart.ts",
    import.meta.url,
  ),
  "utf8",
);

const whiteboardConfiguration = readFileSync(
  new URL(
    "../code-oss/src/vs/whiteboard/common/whiteboardConfigurationDefaults.ts",
    import.meta.url,
  ),
  "utf8",
);

const whiteboardMain = readFileSync(
  new URL(
    "../code-oss/src/vs/whiteboard/electron-browser/whiteboard.main.ts",
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

test("Review mounts VS Code's native back and forward controls", () => {
  assert.match(
    whiteboardMain,
    /new WhiteboardConfigurationService\([\s\S]*?\{ defaultOverrides: whiteboardAgentsWindowDefaultOverrides \}\)/,
    "Review's navigation defaults must survive Review configuration initialization",
  );

  assert.match(
    whiteboardTitlebar,
    /createInstance\(\s*CommandCenterControl,/,
    "Review should mount VS Code's native titlebar control",
  );
  assert.doesNotMatch(
    whiteboardTitlebar,
    /workbench\.action\.navigate(?:Back|Forward)/,
    "Review must not recreate or manually dispatch native navigation actions",
  );
  assert.doesNotMatch(
    whiteboardTitlebar,
    /review-title\b/,
    "the titlebar carries no product label; the branding lives in the macOS application menu",
  );
});

test("the native control can omit the command launcher without hiding navigation", () => {
  const centerMenuItem = commandCenterControl.match(
    /MenuRegistry\.appendMenuItem\(MenuId\.CommandCenter, \{[\s\S]*?submenu: MenuId\.CommandCenterCenter,[\s\S]*?\n\}\);/,
  )?.[0];

  assert.match(
    centerMenuItem ?? "",
    /when: ContextKeyExpr\.has\('config\.window\.commandCenter'\)/,
    "expected the native command-center menu item gated on config.window.commandCenter",
  );
  assert.match(whiteboardConfiguration, /'window\.commandCenter': false,/);
});
