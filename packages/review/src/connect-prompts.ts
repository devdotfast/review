import { cursorInstallDeeplink } from "./cursor-deeplink";
import type { InstallTarget } from "./install";

/** The macOS and Linux launch form; the Claude, Cursor and OpenCode plugins must match it byte for byte, and the Codex plugin's bin/whiteboard-mcp runs the same command. */
export const REVIEW_MCP_LAUNCH = {
  command: "sh",
  args: ["-c", 'exec "$HOME/.local/bin/whiteboard" mcp'],
} as const;

/**
 * Windows has no sh, and Node-based harnesses cannot start a .cmd file
 * directly. cmd finds whiteboard.cmd on PATH, whether the first-run step or
 * the installer put it there. The OpenCode plugin must match it on Windows.
 */
export const WINDOWS_MCP_LAUNCH = {
  command: "cmd",
  args: ["/d", "/c", "whiteboard", "mcp"],
} as const;

export interface ConnectPromptInput {
  /** False when the serving package has no built CLI (Desktop from source): prompts fall back to a bare `whiteboard`. */
  hasShim: boolean;
  legacyPaths: string[];
  traceEnabled: boolean;
  fffBinaryPath: string;
  fffCorpusRoot: string;
  /** Defaults to this process's platform. */
  platform?: NodeJS.Platform;
}

export const FFF_INSTALL_URL =
  "https://raw.githubusercontent.com/dmtrKovalenko/fff/v0.11.0/install-mcp.sh";

export const PI_FFF_PACKAGE = "npm:@ff-labs/pi-fff";

export const PI_WHITEBOARD_PACKAGE = "npm:@dev.fast/pi-whiteboard";

/** A stdio MCP server launch, as harness configs spell it. */
export interface McpLaunch {
  command: string;
  args: string[];
}

export function reviewMcpLaunch(
  hasShim: boolean,
  platform: NodeJS.Platform = process.platform,
): McpLaunch {
  if (platform === "win32")
    return {
      command: WINDOWS_MCP_LAUNCH.command,
      args: [...WINDOWS_MCP_LAUNCH.args],
    };

  return hasShim
    ? {
        command: REVIEW_MCP_LAUNCH.command,
        args: [...REVIEW_MCP_LAUNCH.args],
      }
    : { command: "whiteboard", args: ["mcp"] };
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function numbered(steps: string[]): string[] {
  return steps.map((step, index) => `${index + 1}. ${step}`);
}

function fffSteps(input: ConnectPromptInput, target: InstallTarget): string[] {
  if (!input.traceEnabled) return [];

  if (target === "pi" || target === "omp") {
    return [`Run: ${target} install ${PI_FFF_PACKAGE}`];
  }

  const binary = shellQuote(input.fffBinaryPath);
  const root = shellQuote(input.fffCorpusRoot);
  const add = target === "claude" ? "claude mcp add -s user" : "codex mcp add";

  return [
    `Unless \`${target} mcp get fff\` finds an existing server, run:\n\n\`\`\`sh\n[ -x ${binary} ] || curl -fsSL ${FFF_INSTALL_URL} | bash\n${add} fff -- ${binary} ${root}\n\`\`\``,
  ];
}

/** The Claude plugin's sh launch cannot start on Windows, so register the server directly. */
export const CLAUDE_WINDOWS_MCP_ADD = `claude mcp add -s user whiteboard -- ${WINDOWS_MCP_LAUNCH.command} ${WINDOWS_MCP_LAUNCH.args.join(" ")}`;

function pluginSteps(
  target: Exclude<InstallTarget, "cursor">,
  platform: NodeJS.Platform,
): string[] {
  switch (target) {
    case "claude":
      if (platform === "win32")
        return [
          `Run:\n\n\`\`\`sh\nclaude plugin uninstall whiteboard@devfast # its launch cannot start on Windows, if installed\nclaude mcp remove -s user whiteboard # old registration, if any\n${CLAUDE_WINDOWS_MCP_ADD}\n\`\`\``,
        ];

      return [
        "Run:\n\n```sh\nclaude plugin marketplace add devdotfast/whiteboard\nclaude plugin install whiteboard@devfast --scope user\nclaude mcp remove -s user whiteboard # old manual registration, if any\n```",
      ];
    case "codex":
      return [
        "Run:\n\n```sh\ncodex plugin marketplace add devdotfast/whiteboard\ncodex plugin add whiteboard@devfast\ncodex mcp remove whiteboard # old manual registration, if any\n```",
      ];
    case "opencode":
      return [
        "Run:\n\n```sh\nopencode plugin @dev.fast/opencode-whiteboard --global\n```",
      ];
    case "pi":
    case "omp":
      return [
        `Run:\n\n\`\`\`sh\n${target} install ${PI_WHITEBOARD_PACKAGE}\n\`\`\``,
      ];
  }
}

function cursorSteps(): string[] {
  const launch = reviewMcpLaunch(true);
  const deeplink = cursorInstallDeeplink(launch);
  const entry = JSON.stringify({ whiteboard: launch }, null, 2);

  return [
    `Do not paste the install link in chat. Chat clients do not open cursor:// links. Open Cursor's MCP install deeplink with the OS URL handler using the command for this operating system, then stop and let me confirm the install:\n\nmacOS: open ${shellQuote(deeplink)}\nLinux: xdg-open ${shellQuote(deeplink)}\nWindows: cmd /c start "" "${deeplink}"`,
    `After I confirm, check for a whiteboard server in ~/.cursor/mcp.json. If the deeplink did not add it, merge this entry into the file's mcpServers object without removing other servers or settings (create the file and object if missing). Do not use this fallback if I declined the install:\n\n\`\`\`json\n${entry}\n\`\`\``,
  ];
}

export function connectPrompt(
  target: InstallTarget,
  input: ConnectPromptInput,
): string {
  if (!input.hasShim) {
    return "Connect this agent to dev.fast Whiteboard.\n\nStop and ask me to install the whiteboard command in Whiteboard Desktop (Settings → Command line), then run this connect command again. The connection requires ~/.local/bin/whiteboard.";
  }

  const extra =
    target === "claude" ||
    target === "codex" ||
    target === "pi" ||
    target === "omp"
      ? fffSteps(input, target)
      : [];

  const verify =
    target === "pi" || target === "omp"
      ? `Ask me to run ${target === "pi" ? "/reload in Pi" : "/reload-plugins in oh-my-pi"}, then run \`whiteboard api session_get_instructions '{}'\` and confirm it answered. Do not author anything yet.`
      : target === "opencode"
        ? "Stop and tell me to quit and reopen OpenCode: it loads plugins and MCP servers only at startup. After I reopen it, call `session_get_instructions` on the Whiteboard server to confirm the connection. Do not author anything yet."
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
        ? cursorSteps()
        : [
            ...pluginSteps(target, input.platform ?? process.platform),
            ...extra,
          ]),
      verify,
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
    omp: connectSetupPrompt("omp"),
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
    omp: connectPrompt("omp", input),
  };
}
