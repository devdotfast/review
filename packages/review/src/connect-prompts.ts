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
  legacyPaths: string[];
  traceEnabled: boolean;
  fffBinaryPath: string;
  fffCorpusRoot: string;
}

export const FFF_INSTALL_URL =
  "https://raw.githubusercontent.com/dmtrKovalenko/fff/v0.11.0/install-mcp.sh";

export const PI_FFF_PACKAGE = "npm:@ff-labs/pi-fff";

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

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function numbered(steps: string[]): string[] {
  return steps.map((step, index) => `${index + 1}. ${step}`);
}

function fffSteps(input: ConnectPromptInput, target: InstallTarget): string[] {
  if (!input.traceEnabled) return [];

  if (target === "pi") return [`Run: pi install ${PI_FFF_PACKAGE}`];

  const binary = shellQuote(input.fffBinaryPath);
  const root = shellQuote(input.fffCorpusRoot);
  const add = target === "claude" ? "claude mcp add -s user" : "codex mcp add";

  return [
    `Unless \`${target} mcp get fff\` finds an existing server, run:\n\n\`\`\`sh\n[ -x ${binary} ] || curl -fsSL ${FFF_INSTALL_URL} | bash\n${add} fff -- ${binary} ${root}\n\`\`\``,
  ];
}

function pluginSteps(target: Exclude<InstallTarget, "cursor">): string[] {
  switch (target) {
    case "claude":
      return [
        "Run:\n\n```sh\nclaude plugin marketplace add devdotfast/review\nclaude plugin install whiteboard@devfast --scope user\nclaude mcp remove -s user whiteboard # old manual registration, if any\n```",
      ];
    case "codex":
      return [
        "Run:\n\n```sh\ncodex plugin marketplace add devdotfast/review\ncodex plugin add whiteboard@devfast\ncodex mcp remove whiteboard # old manual registration, if any\n```",
      ];
    case "opencode":
      return [
        "Run:\n\n```sh\nopencode plugin @dev.fast/opencode-whiteboard --global\n```",
      ];
    case "pi":
      return ["Run:\n\n```sh\npi install npm:@dev.fast/pi-whiteboard\n```"];
  }
}

export function connectPrompt(
  target: InstallTarget,
  input: ConnectPromptInput,
): string {
  if (!input.hasShim) {
    return "Connect this agent to dev.fast Whiteboard.\n\nStop and ask me to install the whiteboard command in Whiteboard Desktop (Settings → Command line), then run this connect command again. The connection requires ~/.local/bin/whiteboard.";
  }

  const extra =
    target === "claude" || target === "codex" || target === "pi"
      ? fffSteps(input, target)
      : [];

  const verify =
    target === "pi"
      ? `Ask me to run /reload in Pi, then run \`${whiteboardCli(input.hasShim)} api session_get_instructions '{}'\` and confirm it answered. Do not author anything yet.`
      : "Reload your MCP tools and call `session_get_instructions` on the Whiteboard server. If a restart is needed, tell me and verify after it. Do not author anything yet.";

  return [
    "Connect this agent to dev.fast Whiteboard.",
    "",
    ...numbered([
      ...(input.legacyPaths.length
        ? [
            `Delete these old Whiteboard skill folders and plugin files:\n${input.legacyPaths.map((item) => `- ${JSON.stringify(item)}`).join("\n")}`,
          ]
        : []),
      ...(target === "cursor"
        ? [
            `Show me this link and ask me to confirm the installation in Cursor:\n\n${cursorInstallDeeplink(reviewMcpLaunch(true))}`,
          ]
        : [...pluginSteps(target), ...extra, verify]),
    ]),
  ].join("\n");
}

export function connectSetupPrompt(target: InstallTarget): string {
  return `Run \`whiteboard connect ${target}\` and follow the instructions to connect this agent to Whiteboard.`;
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
