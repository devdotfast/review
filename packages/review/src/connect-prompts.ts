import { cursorInstallDeeplink } from "./cursor-deeplink";
import type { InstallTarget } from "./install";

/** The one launch form every Whiteboard MCP registration uses; plugins must match it byte for byte. */
export const REVIEW_MCP_LAUNCH = {
  command: "sh",
  args: ["-c", 'exec "$HOME/.local/bin/whiteboard" mcp'],
} as const;

export interface ConnectPromptInput {
  /** False when the serving package has no built CLI (Desktop from source): prompts fall back to a bare `whiteboard`. */
  hasShim: boolean;
  traceEnabled: boolean;
  fffBinaryPath: string;
  fffCorpusRoot: string;
}

export const FFF_INSTALL_URL =
  "https://raw.githubusercontent.com/dmtrKovalenko/fff/v0.11.0/install-mcp.sh";

export const PI_FFF_PACKAGE = "npm:@ff-labs/pi-fff";

const LEGACY_SKILL_NAMES =
  "whiteboard, dev-review, dev-review-batch, dev-file-lenses, scratchpad, trace-archaeology, dev-review-map, review, review-map, review-stop, progressive-review or pr-review";

export function reviewMcpLaunch(hasShim: boolean): {
  command: string;
  args: string[];
} {
  return hasShim
    ? {
        command: REVIEW_MCP_LAUNCH.command,
        args: [...REVIEW_MCP_LAUNCH.args],
      }
    : { command: "whiteboard", args: ["mcp"] };
}

function whiteboardCli(hasShim: boolean): string {
  return hasShim ? '"$HOME/.local/bin/whiteboard"' : "whiteboard";
}

const SKILLS_DIRS: Record<InstallTarget, string> = {
  claude: "~/.claude/skills",
  codex: "~/.agents/skills",
  cursor: "~/.cursor/skills",
  opencode: "~/.config/opencode/skills",
  pi: "~/.agents/skills",
};

const removeOldSkills = (target: InstallTarget) =>
  `Look in ${SKILLS_DIRS[target]} for folders named ${LEGACY_SKILL_NAMES}. Inspect each SKILL.md's YAML frontmatter. Delete a folder only when its metadata has review-managed-by: "Review Desktop", a nonempty review-generated string, and review-version set to a semantic version or "development"; or whiteboard-managed-by: "Whiteboard" (or "Whiteboard Desktop"), a nonempty whiteboard-generated string, and whiteboard-version set to a semantic version or "development". Do not follow symlinks. Leave every other folder alone. Verify that the matching legacy folders are gone and the others are unchanged.`;

function numbered(steps: string[]): string[] {
  return steps.map((step, index) => `${index + 1}. ${step}`);
}

function fffSteps(input: ConnectPromptInput, target: InstallTarget): string[] {
  if (!input.traceEnabled) return [];

  if (target === "pi") return [`Run: pi install ${PI_FFF_PACKAGE}`];

  return [
    `Connect Whiteboard's trace search. If ${input.fffBinaryPath} does not exist, install it with: curl -fsSL ${FFF_INSTALL_URL} | bash. Then add a second user-level MCP server named "fff": command ${JSON.stringify(input.fffBinaryPath)}, args ${JSON.stringify([input.fffCorpusRoot])}. If an MCP server named "fff" already exists, leave it unchanged and tell me.`,
  ];
}

function pluginSteps(target: Exclude<InstallTarget, "cursor">): string[] {
  switch (target) {
    case "claude":
      return [
        "Install the Whiteboard plugin for this user. If already installed, ensure it is enabled and skip installation. Otherwise run:\n\n```sh\nclaude plugin marketplace add devdotfast/review\nclaude plugin install whiteboard@devfast --scope user\n```",
        'After the plugin is installed, inspect any manually configured user-level MCP server named "whiteboard". Remove only that duplicate Whiteboard registration with `claude mcp remove -s user whiteboard`; preserve all other servers and settings. Run `claude mcp list` to check the plugin server.',
      ];
    case "codex":
      return [
        "Install the Whiteboard plugin for this user. If already installed, ensure it is enabled and skip installation. Otherwise run:\n\n```sh\ncodex plugin marketplace add devdotfast/review\ncodex plugin add whiteboard@devfast\n```",
        "After the plugin is installed, remove only a duplicate manually configured `[mcp_servers.whiteboard]` entry from the user Codex config. Preserve every other setting and comment. The plugin supplies the Whiteboard skill; do not append instructions to AGENTS.md. Run `codex mcp list` to check the plugin server.",
      ];
    case "opencode":
      return [
        'Add "@dev.fast/opencode-whiteboard" to the "plugin" array in the user OpenCode config (~/.config/opencode/opencode.json, or the existing opencode.jsonc; honor XDG_CONFIG_HOME). Create the config if missing, preserve every existing plugin and setting, and do not add a duplicate. OpenCode installs the npm package when it starts. Do not add a separate manual Whiteboard MCP registration. Run `opencode mcp list` to check the plugin server.',
      ];
    case "pi":
      return [
        "Install the Whiteboard Pi package for this user, unless already installed:\n\n```sh\npi install npm:@dev.fast/pi-whiteboard\n```\nThe package supplies the Whiteboard skill. Do not create another pointer skill or configure an MCP server; Pi uses the CLI.",
      ];
  }
}

export function connectPrompt(
  target: InstallTarget,
  input: ConnectPromptInput,
): string {
  if (target === "cursor") {
    return `Click this link and confirm the installation in Cursor:\n\n${cursorInstallDeeplink(reviewMcpLaunch(true))}`;
  }

  const prerequisites = input.hasShim
    ? []
    : [
        "Install the whiteboard command in Whiteboard Desktop (Settings → Command line) before installing the plugin. The plugins require ~/.local/bin/whiteboard.",
      ];

  const extra =
    target === "claude" || target === "codex" || target === "pi"
      ? fffSteps(input, target)
      : [];

  const verify =
    target === "pi"
      ? `Reload Pi to load the package, then run \`${whiteboardCli(input.hasShim)} api session_get_instructions '{}'\` and confirm it answered. Do not author anything yet.`
      : "Reload your MCP tools and call session_get_instructions from the Whiteboard server to verify the connection. If a restart is required, tell me to restart and resume verification in the new session. Do not claim success until the tool answers. Do not author anything yet.";

  return [
    "Connect this agent to dev.fast Whiteboard.",
    "",
    ...numbered([
      ...prerequisites,
      removeOldSkills(target),
      ...pluginSteps(target),
      ...extra,
      verify,
    ]),
  ].join("\n");
}

export function connectSetupPrompt(target: InstallTarget): string {
  return `Run \`whiteboard mcp install-instructions --harness ${target}\` and follow the instructions to connect this agent to Whiteboard.`;
}

export function connectSetupPrompts(): Record<InstallTarget, string> {
  return {
    claude: connectSetupPrompt("claude"),
    codex: connectSetupPrompt("codex"),
    cursor: connectSetupPrompt("cursor"),
    opencode: connectSetupPrompt("opencode"),
    pi: connectSetupPrompt("pi"),
  };
}

export function connectPrompts(
  input: ConnectPromptInput,
): Record<InstallTarget, string> {
  return {
    claude: connectPrompt("claude", input),
    codex: connectPrompt("codex", input),
    cursor: connectPrompt("cursor", input),
    opencode: connectPrompt("opencode", input),
    pi: connectPrompt("pi", input),
  };
}
