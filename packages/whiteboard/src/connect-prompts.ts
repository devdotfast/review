import type { InstallTarget } from "./install";

/** The one launch form every Whiteboard MCP registration uses; plugins must match it byte for byte. */
export const WHITEBOARD_MCP_LAUNCH = {
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

export function whiteboardMcpLaunch(hasShim: boolean): {
  command: string;
  args: string[];
} {
  return hasShim
    ? {
        command: WHITEBOARD_MCP_LAUNCH.command,
        args: [...WHITEBOARD_MCP_LAUNCH.args],
      }
    : { command: "whiteboard", args: ["mcp"] };
}

/** `command "sh", args ["-c","exec \"$HOME/.local/bin/whiteboard\" mcp"]`, JSON-escaped so agents copy it verbatim. */
function launchText(hasShim: boolean): string {
  const launch = whiteboardMcpLaunch(hasShim);

  return `command ${JSON.stringify(launch.command)}, args ${JSON.stringify(launch.args)}`;
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
  `Look in ${SKILLS_DIRS[target]} for folders named ${LEGACY_SKILL_NAMES}. Delete any whose SKILL.md says it is managed by Review Desktop or Whiteboard. Leave every other folder alone.`;

function pathNote(hasShim: boolean): string {
  return hasShim
    ? ""
    : " Whiteboard Desktop has no installed command on this machine, so whiteboard must be on the PATH of the agent.";
}

function numbered(steps: string[]): string[] {
  return steps.map((step, index) => `${index + 1}. ${step}`);
}

function mcpPrompt(
  target: InstallTarget,
  input: ConnectPromptInput,
  extra: string[],
): string {
  const homeNote = input.hasShim
    ? " Keep `$HOME` literal in the args; sh expands it when the server starts. Do not replace it with the expanded path."
    : "";

  return [
    "Connect this agent to dev.fast Whiteboard.",
    "",
    ...numbered([
      `Add an MCP server named "whiteboard" to my user-level (global) MCP configuration, not this project's: ${launchText(input.hasShim)}, no environment variables.${homeNote} If a "whiteboard" server already exists, replace it. Skip step 1 if the Whiteboard plugin is already installed.${pathNote(input.hasShim)}`,
      removeOldSkills(target),
      ...extra,
      "Reload your MCP tools, or tell me that a restart is needed. Then call session_get_instructions and confirm it answered. Do not author anything yet.",
    ]),
  ].join("\n");
}

function fffSteps(input: ConnectPromptInput, target: InstallTarget): string[] {
  if (!input.traceEnabled) return [];

  if (target === "pi") return [`Run: pi install ${PI_FFF_PACKAGE}`];

  return [
    `Connect Whiteboard's trace search. If ${input.fffBinaryPath} does not exist, install it with: curl -fsSL ${FFF_INSTALL_URL} | bash. Then add a second user-level MCP server named "fff": command ${JSON.stringify(input.fffBinaryPath)}, args ${JSON.stringify([input.fffCorpusRoot])}. If an MCP server named "fff" already exists, leave it unchanged and tell me.`,
  ];
}

function piPrompt(input: ConnectPromptInput): string {
  const cli = whiteboardCli(input.hasShim);

  const skill = [
    "---",
    "name: whiteboard",
    'description: "Explain code in Whiteboard, the architecture-visualization tool: author Whiteboards of branches, changes and pull requests, draw on the Whiteboard scratchpad, or research why code exists from past agent sessions."',
    "---",
    "",
    "# dev.fast Whiteboard",
    "",
    `Whiteboard serves its own instructions. Before authoring, run \`${cli} api session_get_instructions '{}'\` and follow the result. Pass \`'{"topic":"scratchpad"}'\` to explain code visually, or \`'{"topic":"trace-archaeology"}'\` to research why code exists. If Whiteboard is not running, the response says how to start it.`,
  ].join("\n");

  return [
    "Connect this agent to dev.fast Whiteboard.",
    "",
    ...numbered([
      removeOldSkills("pi"),
      `Create ${SKILLS_DIRS.pi}/whiteboard/SKILL.md. The file's content is exactly the fenced block below. Skip step 2 if the Whiteboard package for Pi is already installed.\n\n\`\`\`markdown\n${skill}\n\`\`\`\n`,
      ...fffSteps(input, "pi"),
      `Run \`${cli} api session_get_instructions '{}'\` once and confirm it answered. Do not author anything yet.${pathNote(input.hasShim)}`,
    ]),
  ].join("\n");
}

export function connectPrompt(
  target: InstallTarget,
  input: ConnectPromptInput,
): string {
  if (target === "pi") return piPrompt(input);

  const extra =
    target === "codex"
      ? [
          'Append this line to ~/.codex/AGENTS.md, creating the file if needed, unless that line is already there: "For code reviews and explaining code, use the whiteboard MCP server: call session_get_instructions first."',
        ]
      : [];

  const fff =
    target === "claude" || target === "codex" ? fffSteps(input, target) : [];

  return mcpPrompt(target, input, [...extra, ...fff]);
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
