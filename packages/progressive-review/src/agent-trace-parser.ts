import path from "node:path";

import {
  type JsonObject,
  type ReviewAgentTraceEvent,
  type ReviewAgentTraceSession,
  isJsonObject,
} from "@dev.fast/review-protocol";

export const AGENT_TRACE_PARSER_VERSION = "1";

export type AgentTraceHarness = ReviewAgentTraceSession["harness"];
export type AgentTraceEvent = ReviewAgentTraceEvent;
export type AgentTraceUserEvent = Extract<AgentTraceEvent, { kind: "user" }>;
export type AgentTraceAssistantEvent = Extract<
  AgentTraceEvent,
  { kind: "assistant" }
>;
export type AgentTraceToolEvent = Extract<AgentTraceEvent, { kind: "tool" }>;
export type AgentTraceSeparatorEvent = Extract<
  AgentTraceEvent,
  { kind: "separator" }
>;

// The one text projection of an event. TraceQuote validation matches quotes
// against this text, so any surface that shows event text for quote picking
// must use the same projection.
export function extractTraceEventText(event: AgentTraceEvent): string {
  if (event.kind === "user") return event.text;
  if (event.kind === "assistant") return event.markdown;
  if (event.kind === "tool") {
    return [event.title, event.command, event.input, event.output]
      .filter(Boolean)
      .join(" ");
  }
  if (event.kind === "separator") return event.label;
  return "";
}

export interface AgentTraceParseResult {
  harness: AgentTraceHarness;
  title: string | null;
  events: AgentTraceEvent[];
  startedAt: string | null;
  endedAt: string | null;
  /** Active work time: idle gaps longer than ten minutes are excluded. */
  activeMs: number | null;
  userTurns: number;
  toolCalls: number;
}

const ACTIVE_GAP_LIMIT_MS = 10 * 60 * 1000;

function computeActiveMs(events: AgentTraceEvent[]): number | null {
  let total = 0;
  let previous: number | null = null;
  let sawTimestamp = false;
  for (const event of events) {
    const at = timestampOf(event);
    if (at === null) continue;
    sawTimestamp = true;
    if (previous !== null && at > previous) {
      total += Math.min(at - previous, ACTIVE_GAP_LIMIT_MS);
    }
    previous = at;
  }
  return sawTimestamp ? total : null;
}

const OUTPUT_LIMIT = 20_000;
const INPUT_LIMIT = 4_000;
const TITLE_LIMIT = 160;

export function sniffAgentTraceHarness(
  jsonlFirstChunk: string,
): AgentTraceHarness {
  for (const line of jsonlFirstChunk.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as { type?: unknown };
      if (record.type === "session_meta") return "codex";
      if (record.type === "session") return "pi";
      return "claude-code";
    } catch {
      continue;
    }
  }
  return "unknown";
}

export function parseAgentTraceJsonl(
  jsonl: string,
  options?: { isSubagent?: boolean },
): AgentTraceParseResult {
  const records: unknown[] = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // Partial trailing writes are expected in live transcripts.
    }
  }
  const first = records[0] as { type?: unknown } | undefined;
  const parsed =
    first?.type === "session_meta"
      ? parseCodexRecords(records)
      : first?.type === "session"
        ? parsePiRecords(records)
        : parseClaudeRecords(records, options);
  parsed.activeMs = computeActiveMs(parsed.events);
  return parsed;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n… (+${text.length - limit} characters omitted) …\n${text.slice(-half)}`;
}

function compactLine(text: string, limit = TITLE_LIMIT): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit - 1)}…`;
}

/** File titles keep their tail: the filename matters more than the prefix. */
function compactFileLine(text: string, limit = TITLE_LIMIT): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  return `…${collapsed.slice(-(limit - 1))}`;
}

function relativizePath(filePath: string, cwd: string | null): string {
  if (!cwd) return filePath;
  const relative = path.relative(cwd, filePath);
  if (!relative || relative.startsWith("..")) return filePath;
  return relative;
}

function timestampOf(event: AgentTraceEvent | undefined): number | null {
  if (!event || event.kind === "separator" || !event.at) return null;
  const value = Date.parse(event.at);
  return Number.isFinite(value) ? value : null;
}

// --- Claude Code transcripts ----------------------------------------------

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeRecord {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  timestamp?: string;
  cwd?: string;
  aiTitle?: string;
  customTitle?: string;
  message?: { role?: string; content?: unknown };
  toolUseResult?: {
    filePath?: string;
    structuredPatch?: Array<{ lines?: string[] }>;
  };
}

function claudeContentBlocks(content: unknown): ClaudeContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content as ClaudeContentBlock[];
  return [];
}

const CLAUDE_NOISE_PATTERNS = [
  /^\[SYSTEM NOTIFICATION/,
  /^\[Request interrupted/,
  /^This session is being continued/,
  /^<task-notification>/,
  /^<local-command-stdout>/,
];

function cleanClaudeUserText(text: string): string | null {
  let cleaned = text;
  cleaned = cleaned.replace(
    /<system-reminder>[\s\S]*?<\/system-reminder>/g,
    "",
  );
  cleaned = cleaned.replace(
    /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
    "",
  );
  const commandName = /<command-name>([\s\S]*?)<\/command-name>/.exec(
    cleaned,
  )?.[1];
  if (commandName) {
    const args =
      /<command-args>([\s\S]*?)<\/command-args>/.exec(cleaned)?.[1] ?? "";
    const slash = commandName.trim().startsWith("/") ? "" : "/";
    return `${slash}${commandName.trim()} ${args.trim()}`.trim();
  }
  cleaned = cleaned.trim();
  if (!cleaned) return null;
  for (const pattern of CLAUDE_NOISE_PATTERNS) {
    if (pattern.test(cleaned)) return null;
  }
  return cleaned;
}

function claudeResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as ClaudeContentBlock[]) {
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block?.type === "image") {
      parts.push("[image]");
    }
  }
  return parts.join("\n");
}

function patchCounts(
  patch: Array<{ lines?: string[] }> | undefined,
): { additions: number; deletions: number } | null {
  if (!patch) return null;
  let additions = 0;
  let deletions = 0;
  for (const hunk of patch) {
    for (const line of hunk.lines ?? []) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
  }
  return { additions, deletions };
}

function claudeToolEvent(
  block: ClaudeContentBlock,
  at: string | undefined,
  cwd: string | null,
): AgentTraceToolEvent {
  const name = block.name ?? "tool";
  const input: JsonObject = isJsonObject(block.input) ? block.input : {};
  const event: AgentTraceToolEvent = {
    kind: "tool",
    tool: name,
    verb: "Called",
    title: name,
    at,
  };
  const inputText = (key: string): string | null => {
    const value = input[key];
    return typeof value === "string" ? value : null;
  };
  const filePath =
    inputText("file_path") ?? inputText("path") ?? inputText("notebook_path");
  switch (name) {
    case "Bash": {
      const command = inputText("command") ?? "";
      event.verb = "Ran";
      event.title = compactLine(command);
      event.command = truncate(command, INPUT_LIMIT);
      break;
    }
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      event.verb = "Edited";
      event.title = filePath ? relativizePath(filePath, cwd) : name;
      if (filePath) event.filePath = relativizePath(filePath, cwd);
      break;
    case "Write":
      event.verb = "Wrote";
      event.title = filePath ? relativizePath(filePath, cwd) : name;
      if (filePath) event.filePath = relativizePath(filePath, cwd);
      break;
    case "Read":
      event.verb = "Read";
      event.title = filePath ? relativizePath(filePath, cwd) : name;
      if (filePath) event.filePath = relativizePath(filePath, cwd);
      break;
    case "Grep":
    case "Glob": {
      const pattern = inputText("pattern") ?? "";
      event.verb = "Searched";
      event.title = compactLine(
        inputText("path")
          ? `${pattern} in ${relativizePath(inputText("path") ?? "", cwd)}`
          : pattern,
      );
      break;
    }
    case "Task":
    case "Agent": {
      event.verb = "Ran agent";
      event.title = compactLine(
        inputText("description") ?? inputText("prompt") ?? "subagent",
      );
      break;
    }
    case "WebFetch":
      event.verb = "Fetched";
      event.title = compactLine(inputText("url") ?? "");
      break;
    case "WebSearch":
      event.verb = "Searched web";
      event.title = compactLine(inputText("query") ?? "");
      break;
    case "TodoWrite":
      event.verb = "Updated";
      event.title = "task list";
      break;
    case "Skill":
      event.verb = "Loaded skill";
      event.title = compactLine(inputText("skill") ?? "");
      break;
    default: {
      if (name.startsWith("mcp__")) {
        event.verb = "Called";
        event.title = name.replace(/^mcp__/, "").replace(/__/g, " · ");
      }
      break;
    }
  }
  if (!event.command) {
    const pretty = JSON.stringify(input, null, 2);
    if (pretty && pretty !== "{}") event.input = truncate(pretty, INPUT_LIMIT);
  }
  return event;
}

function parseClaudeRecords(
  records: unknown[],
  options?: { isSubagent?: boolean },
): AgentTraceParseResult {
  const events: AgentTraceEvent[] = [];
  const pendingTools = new Map<string, AgentTraceToolEvent>();
  let title: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let cwd: string | null = null;
  let userTurns = 0;
  let toolCalls = 0;

  for (const raw of records) {
    const record = raw as ClaudeRecord;
    if (record.type === "ai-title" && typeof record.aiTitle === "string") {
      title ??= record.aiTitle;
      continue;
    }
    if (
      record.type === "custom-title" &&
      typeof record.customTitle === "string"
    ) {
      title = record.customTitle;
      continue;
    }
    if (record.type !== "user" && record.type !== "assistant") continue;
    if (!options?.isSubagent && record.isSidechain) continue;
    cwd ??= record.cwd ?? null;
    const at = record.timestamp;
    if (at) {
      startedAt ??= at;
      endedAt = at;
    }
    const blocks = claudeContentBlocks(record.message?.content);
    if (record.type === "user") {
      let sawToolResult = false;
      for (const block of blocks) {
        if (block?.type !== "tool_result") continue;
        sawToolResult = true;
        const pending = block.tool_use_id
          ? pendingTools.get(block.tool_use_id)
          : undefined;
        if (!pending) continue;
        const resultText = claudeResultText(block.content).trim();
        if (resultText) pending.output = truncate(resultText, OUTPUT_LIMIT);
        if (block.is_error) pending.error = true;
        const counts = patchCounts(record.toolUseResult?.structuredPatch);
        if (counts) {
          pending.additions = counts.additions;
          pending.deletions = counts.deletions;
        }
        if (record.toolUseResult?.filePath && !pending.filePath) {
          pending.filePath = relativizePath(record.toolUseResult.filePath, cwd);
        }
        if (block.tool_use_id) pendingTools.delete(block.tool_use_id);
      }
      if (sawToolResult || record.isMeta) continue;
      const text = blocks
        .filter(
          (block) => block?.type === "text" && typeof block.text === "string",
        )
        .map((block) => block.text as string)
        .join("\n");
      const cleaned = cleanClaudeUserText(text);
      if (!cleaned) continue;
      userTurns += 1;
      events.push({ kind: "user", text: cleaned, at });
      continue;
    }
    for (const block of blocks) {
      if (block?.type === "thinking" && typeof block.thinking === "string") {
        const trimmed = block.thinking.trim();
        if (trimmed) {
          events.push({
            kind: "assistant",
            markdown: trimmed,
            thinking: true,
            at,
          });
        }
      } else if (block?.type === "text" && typeof block.text === "string") {
        const trimmed = block.text.trim();
        if (trimmed) events.push({ kind: "assistant", markdown: trimmed, at });
      } else if (block?.type === "tool_use") {
        const event = claudeToolEvent(block, at, cwd);
        toolCalls += 1;
        events.push(event);
        if (block.id) pendingTools.set(block.id, event);
      }
    }
  }

  return {
    harness: "claude-code",
    title,
    events,
    startedAt,
    endedAt,
    activeMs: null,
    userTurns,
    toolCalls,
  };
}

// --- Codex rollouts --------------------------------------------------------

interface CodexPayload {
  type?: string;
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  name?: string;
  arguments?: unknown;
  input?: unknown;
  call_id?: string;
  output?: unknown;
  action?: { query?: string };
  cwd?: string;
  timestamp?: string;
  message?: string;
  query?: string;
  stdout?: string;
  success?: boolean;
  changes?: Record<
    string,
    { type?: string; unified_diff?: string; content?: string }
  >;
  invocation?: {
    server?: string;
    tool?: string;
    arguments?: unknown;
  };
  result?: unknown;
  command?: unknown;
  aggregated_output?: string;
  exit_code?: number;
}

interface CodexRecord {
  type?: string;
  timestamp?: string;
  payload?: CodexPayload;
}

const CODEX_USER_NOISE_PREFIXES = [
  "<recommended_plugins",
  "<permissions",
  "<environment_context",
  "<environments_instructions",
  "<user_instructions",
  "<user_shell_command",
  "<turn_aborted",
  "<subagent_notification",
  "<codex_internal_context",
  "<goal_context",
  "<codex_delegation",
  "<external_",
  "<skills_instructions",
  "<skill>",
  "<apps_instructions",
  "<plugins_instructions",
  "<tools>",
  "<collaboration_mode",
  "<multi_agent_mode",
  "<multi_agent_role",
  "<realtime_conversation",
  "<context_window",
  "<turn_context",
  "<model_switch",
  "<personality_spec",
  "<token_budget",
  "<rollout_budget",
  "<git_attribution",
  "<ENVIRONMENT",
  "# AGENTS",
];

function codexText(payload: CodexPayload): string {
  return (payload.content ?? [])
    .filter(
      (block) =>
        (block?.type === "input_text" || block?.type === "output_text") &&
        typeof block.text === "string",
    )
    .map((block) => block.text as string)
    .join("\n")
    .trim();
}

function codexPatchSummary(patch: string, cwd: string | null) {
  const files: string[] = [];
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    const header = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      files.push(relativizePath(header[1].trim(), cwd));
      continue;
    }
    if (line.startsWith("***")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { filePath: files[0], additions, deletions, files };
}

const CODE_MODE_FILE_PATTERN =
  /\*\*\* (?:Add|Update|Delete) File: ([^\n\\"`]+)/g;

function unifiedDiffCounts(diff: string) {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function codexValueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function codexPatchEvent(
  payload: CodexPayload,
  at: string | undefined,
  cwd: string | null,
): AgentTraceToolEvent | null {
  const changes = payload.changes ?? {};
  const paths = Object.keys(changes);
  if (paths.length === 0) return null;
  let additions = 0;
  let deletions = 0;
  const relativePaths = paths.map((filePath) => relativizePath(filePath, cwd));
  for (const filePath of paths) {
    const change = changes[filePath] ?? {};
    if (change.type === "add" && typeof change.content === "string") {
      additions += change.content.split("\n").length;
    } else if (change.type === "delete" && typeof change.content === "string") {
      deletions += change.content.split("\n").length;
    } else if (typeof change.unified_diff === "string") {
      const counts = unifiedDiffCounts(change.unified_diff);
      additions += counts.additions;
      deletions += counts.deletions;
    }
  }
  const single = paths.length === 1 ? changes[paths[0]] : null;
  const verb =
    single?.type === "add"
      ? "Added"
      : single?.type === "delete"
        ? "Deleted"
        : "Edited";
  const event: AgentTraceToolEvent = {
    kind: "tool",
    tool: "apply_patch",
    verb,
    title: compactFileLine(relativePaths.join(", ")),
    filePath: relativePaths[0],
    additions,
    deletions,
    at,
  };
  const diffs = paths
    .map((filePath) => changes[filePath]?.unified_diff)
    .filter((diff): diff is string => typeof diff === "string");
  if (diffs.length > 0) event.input = truncate(diffs.join("\n"), INPUT_LIMIT);
  if (payload.stdout) event.output = truncate(payload.stdout, OUTPUT_LIMIT);
  if (payload.success === false) event.error = true;
  return event;
}

function codexMcpEvent(
  payload: CodexPayload,
  at: string | undefined,
): AgentTraceToolEvent {
  const invocation = payload.invocation ?? {};
  const server =
    typeof invocation.server === "string" ? invocation.server : "mcp";
  const tool = typeof invocation.tool === "string" ? invocation.tool : "tool";
  const argumentsValue = invocation.arguments as
    | { title?: unknown }
    | undefined;
  const title =
    argumentsValue && typeof argumentsValue.title === "string"
      ? `${server} · ${tool} — ${argumentsValue.title}`
      : `${server} · ${tool}`;
  const event: AgentTraceToolEvent = {
    kind: "tool",
    tool: `${server}.${tool}`,
    verb: "Called",
    title: compactLine(title),
    at,
  };
  const input = codexValueText(invocation.arguments);
  if (input && input !== "{}") event.input = truncate(input, INPUT_LIMIT);
  const result = payload.result as
    | {
        Ok?: {
          content?: Array<{ type?: string; text?: string }>;
          isError?: boolean;
        };
        Err?: unknown;
      }
    | undefined;
  if (result?.Ok?.content) {
    const text = result.Ok.content
      .filter(
        (block) => block?.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text as string)
      .join("\n")
      .trim();
    if (text) event.output = truncate(text, OUTPUT_LIMIT);
    if (result.Ok.isError) event.error = true;
  } else if (result && "Err" in result) {
    event.error = true;
    event.output = truncate(codexValueText(result.Err), OUTPUT_LIMIT);
  }
  return event;
}

function codexCodeModeEvent(
  event: AgentTraceToolEvent,
  source: string,
  cwd: string | null,
  skipPatches: boolean,
): AgentTraceToolEvent | null {
  const cmdMatch = /"cmd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(source);
  if (cmdMatch) {
    let command = cmdMatch[1];
    try {
      command = JSON.parse(`"${cmdMatch[1]}"`) as string;
    } catch {
      // Keep the escaped form.
    }
    event.verb = "Ran";
    event.title = compactLine(command);
    event.command = truncate(command, INPUT_LIMIT);
    return event;
  }
  const files: string[] = [];
  for (const match of source.matchAll(CODE_MODE_FILE_PATTERN)) {
    const file = relativizePath(match[1].trim(), cwd);
    if (!files.includes(file)) files.push(file);
  }
  if (files.length > 0) {
    if (skipPatches) return null;
    event.verb = "Edited";
    event.title = compactFileLine(files.join(", "));
    event.filePath = files[0];
    event.input = truncate(source, INPUT_LIMIT);
    return event;
  }
  const inner = /tools\.(\w+)\(/.exec(source);
  if (inner) {
    if (inner[1] === "wait") return null;
    if (inner[1].startsWith("mcp__")) return null;
    event.verb = "Called";
    event.title = inner[1].replace(/^mcp__/, "").replace(/__/g, " · ");
    event.input = truncate(source, INPUT_LIMIT);
    return event;
  }
  return null;
}

function codexToolEvent(
  payload: CodexPayload,
  at: string | undefined,
  cwd: string | null,
  flags: { hasPatchEvents: boolean; hasMcpEvents: boolean },
): AgentTraceToolEvent | null {
  const name = payload.name ?? "tool";
  if (name === "wait") return null;
  const event: AgentTraceToolEvent = {
    kind: "tool",
    tool: name,
    verb: "Called",
    title: name,
    at,
  };
  if (
    name === "exec" ||
    name === "exec_command" ||
    name === "shell" ||
    name === "local_shell"
  ) {
    const source = codexValueText(payload.arguments ?? payload.input);
    if (source.includes("tools.")) {
      return codexCodeModeEvent(event, source, cwd, flags.hasPatchEvents);
    }
    let command = source;
    try {
      const parsed = JSON.parse(source || "{}") as {
        cmd?: string;
        command?: string[] | string;
      };
      command =
        typeof parsed.cmd === "string"
          ? parsed.cmd
          : Array.isArray(parsed.command)
            ? parsed.command.join(" ")
            : typeof parsed.command === "string"
              ? parsed.command
              : command;
    } catch {
      // Keep the raw arguments string.
    }
    event.verb = "Ran";
    event.title = compactLine(command);
    event.command = truncate(command, INPUT_LIMIT);
    return event;
  }
  if (name === "apply_patch") {
    if (flags.hasPatchEvents) return null;
    const patchInput = codexValueText(payload.input);
    const summary = codexPatchSummary(patchInput, cwd);
    event.verb = "Edited";
    event.title = compactFileLine(summary.files.join(", ") || "files");
    event.filePath = summary.filePath;
    event.additions = summary.additions;
    event.deletions = summary.deletions;
    event.input = truncate(patchInput, INPUT_LIMIT);
    return event;
  }
  const inputSource = codexValueText(payload.arguments ?? payload.input);
  if (inputSource) event.input = truncate(inputSource, INPUT_LIMIT);
  return event;
}

function codexOutputText(output: unknown): string {
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output) as { output?: unknown };
      if (typeof parsed.output === "string") return parsed.output;
    } catch {
      // Raw output string.
    }
    return output;
  }
  if (output && typeof output === "object") {
    const inner = (output as { output?: unknown }).output;
    if (typeof inner === "string") return inner;
    return codexValueText(output);
  }
  return "";
}

function parseCodexRecords(records: unknown[]): AgentTraceParseResult {
  const events: AgentTraceEvent[] = [];
  const pendingTools = new Map<string, AgentTraceToolEvent>();
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let cwd: string | null = null;
  let userTurns = 0;
  let toolCalls = 0;
  let firstUserText: string | null = null;

  let hasMessageEvents = false;
  let hasPatchEvents = false;
  let hasMcpEvents = false;
  for (const raw of records) {
    const record = raw as CodexRecord;
    if (record.type !== "event_msg") continue;
    const eventType = record.payload?.type;
    if (eventType === "user_message" || eventType === "agent_message") {
      hasMessageEvents = true;
    } else if (eventType === "patch_apply_end") {
      hasPatchEvents = true;
    } else if (eventType === "mcp_tool_call_end") {
      hasMcpEvents = true;
    }
  }
  const flags = { hasPatchEvents, hasMcpEvents };

  for (const raw of records) {
    const record = raw as CodexRecord;
    const payload = record.payload;
    if (record.type === "session_meta") {
      cwd = payload?.cwd ?? null;
      startedAt ??= payload?.timestamp ?? record.timestamp ?? null;
      continue;
    }
    const at = record.timestamp;
    if (record.type === "event_msg" && payload) {
      if (at) {
        startedAt ??= at;
        endedAt = at;
      }
      switch (payload.type) {
        case "user_message": {
          const text = (payload.message ?? "").trim();
          if (!text) break;
          const lowered = text.trimStart().toLowerCase();
          if (
            CODEX_USER_NOISE_PREFIXES.some((prefix) =>
              lowered.startsWith(prefix.toLowerCase()),
            )
          ) {
            break;
          }
          userTurns += 1;
          firstUserText ??= text;
          events.push({ kind: "user", text, at });
          break;
        }
        case "agent_message": {
          const text = (payload.message ?? "").trim();
          if (text) events.push({ kind: "assistant", markdown: text, at });
          break;
        }
        case "patch_apply_end": {
          const event = codexPatchEvent(payload, at, cwd);
          if (event) {
            toolCalls += 1;
            events.push(event);
          }
          break;
        }
        case "mcp_tool_call_end": {
          toolCalls += 1;
          events.push(codexMcpEvent(payload, at));
          break;
        }
        case "web_search_end": {
          toolCalls += 1;
          events.push({
            kind: "tool",
            tool: "web_search",
            verb: "Searched web",
            title: compactLine(payload.query ?? ""),
            at,
          });
          break;
        }
        case "exec_command_end": {
          const command = Array.isArray(payload.command)
            ? (payload.command as string[]).join(" ")
            : codexValueText(payload.command);
          if (!command) break;
          toolCalls += 1;
          const event: AgentTraceToolEvent = {
            kind: "tool",
            tool: "exec",
            verb: "Ran",
            title: compactLine(command),
            command: truncate(command, INPUT_LIMIT),
            at,
          };
          if (payload.aggregated_output) {
            event.output = truncate(payload.aggregated_output, OUTPUT_LIMIT);
          }
          if (
            typeof payload.exit_code === "number" &&
            payload.exit_code !== 0
          ) {
            event.error = true;
          }
          events.push(event);
          break;
        }
        default:
          break;
      }
      continue;
    }
    if (record.type !== "response_item" || !payload) continue;
    if (at) {
      startedAt ??= at;
      endedAt = at;
    }
    switch (payload.type) {
      case "message": {
        if (hasMessageEvents) break;
        const text = codexText(payload);
        if (!text) break;
        if (payload.role === "user") {
          const lowered = text.trimStart().toLowerCase();
          if (
            CODEX_USER_NOISE_PREFIXES.some((prefix) =>
              lowered.startsWith(prefix.toLowerCase()),
            )
          ) {
            break;
          }
          userTurns += 1;
          events.push({ kind: "user", text, at });
        } else if (payload.role === "assistant") {
          events.push({ kind: "assistant", markdown: text, at });
        }
        break;
      }
      case "function_call":
      case "custom_tool_call": {
        const event = codexToolEvent(payload, at, cwd, flags);
        if (!event) break;
        toolCalls += 1;
        events.push(event);
        if (payload.call_id) pendingTools.set(payload.call_id, event);
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const pending = payload.call_id
          ? pendingTools.get(payload.call_id)
          : undefined;
        if (!pending) break;
        const text = codexOutputText(payload.output).trim();
        if (text && !pending.output) {
          pending.output = truncate(text, OUTPUT_LIMIT);
        }
        if (payload.call_id) pendingTools.delete(payload.call_id);
        break;
      }
      case "web_search_call": {
        break;
      }
      default:
        break;
    }
  }

  return {
    harness: "codex",
    title: firstUserText ? compactLine(firstUserText) : null,
    events,
    startedAt,
    endedAt,
    activeMs: null,
    userTurns,
    toolCalls,
  };
}

// --- Pi sessions -----------------------------------------------------------

interface PiContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: JsonObject;
}

interface PiRecord {
  type?: string;
  timestamp?: string;
  cwd?: string;
  message?: {
    role?: string;
    toolCallId?: string;
    content?: PiContentBlock[] | string;
  };
}

function piText(content: PiContentBlock[] | string | undefined): string {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
}

function piToolEvent(
  block: PiContentBlock,
  at: string | undefined,
  cwd: string | null,
): AgentTraceToolEvent {
  const name = block.name ?? "tool";
  const args: JsonObject = block.arguments ?? {};
  const argText = (key: string): string | null => {
    const value = args[key];
    return typeof value === "string" ? value : null;
  };
  const event: AgentTraceToolEvent = {
    kind: "tool",
    tool: name,
    verb: "Called",
    title: name,
    at,
  };
  const pathValue = argText("path");
  switch (name) {
    case "bash": {
      const command = argText("command") ?? "";
      event.verb = "Ran";
      event.title = compactLine(command);
      event.command = truncate(command, INPUT_LIMIT);
      break;
    }
    case "read":
      event.verb = "Read";
      event.title = pathValue
        ? compactFileLine(relativizePath(pathValue, cwd))
        : name;
      if (pathValue) event.filePath = relativizePath(pathValue, cwd);
      break;
    case "edit":
      event.verb = "Edited";
      event.title = pathValue
        ? compactFileLine(relativizePath(pathValue, cwd))
        : name;
      if (pathValue) event.filePath = relativizePath(pathValue, cwd);
      break;
    case "write":
      event.verb = "Wrote";
      event.title = pathValue
        ? compactFileLine(relativizePath(pathValue, cwd))
        : name;
      if (pathValue) event.filePath = relativizePath(pathValue, cwd);
      if (typeof args.content === "string") {
        event.additions = (args.content as string).split("\n").length;
      }
      break;
    case "subagent":
      event.verb = "Ran agent";
      event.title = compactLine(codexValueText(args.action));
      break;
    case "web_search":
      event.verb = "Searched web";
      event.title = compactLine(argText("query") ?? "");
      break;
    default:
      break;
  }
  if (!event.command) {
    const pretty = codexValueText(args);
    if (pretty && pretty !== "{}") event.input = truncate(pretty, INPUT_LIMIT);
  }
  return event;
}

function parsePiRecords(records: unknown[]): AgentTraceParseResult {
  const events: AgentTraceEvent[] = [];
  const pendingTools = new Map<string, AgentTraceToolEvent>();
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let cwd: string | null = null;
  let userTurns = 0;
  let toolCalls = 0;
  let firstUserText: string | null = null;

  for (const raw of records) {
    const record = raw as PiRecord;
    if (record.type === "session") {
      cwd = record.cwd ?? null;
      startedAt ??= record.timestamp ?? null;
      continue;
    }
    if (record.type !== "message" || !record.message) continue;
    const at = record.timestamp;
    if (at) {
      startedAt ??= at;
      endedAt = at;
    }
    const message = record.message;
    if (message.role === "user") {
      const text = piText(message.content);
      if (!text) continue;
      const lowered = text.trimStart().toLowerCase();
      if (
        CODEX_USER_NOISE_PREFIXES.some((prefix) =>
          lowered.startsWith(prefix.toLowerCase()),
        )
      ) {
        continue;
      }
      userTurns += 1;
      firstUserText ??= text;
      events.push({ kind: "user", text, at });
      continue;
    }
    if (message.role === "assistant") {
      if (typeof message.content === "string") {
        const trimmed = message.content.trim();
        if (trimmed) events.push({ kind: "assistant", markdown: trimmed, at });
        continue;
      }
      for (const block of Array.isArray(message.content)
        ? message.content
        : []) {
        if (block?.type === "thinking" && typeof block.thinking === "string") {
          const trimmed = block.thinking.trim();
          if (trimmed) {
            events.push({
              kind: "assistant",
              markdown: trimmed,
              thinking: true,
              at,
            });
          }
        } else if (block?.type === "text" && typeof block.text === "string") {
          const trimmed = block.text.trim();
          if (trimmed)
            events.push({ kind: "assistant", markdown: trimmed, at });
        } else if (block?.type === "toolCall") {
          if (block.name === "subagent_wait") continue;
          const event = piToolEvent(block, at, cwd);
          toolCalls += 1;
          events.push(event);
          if (block.id) pendingTools.set(block.id, event);
        }
      }
      continue;
    }
    if (message.role === "toolResult") {
      const pending = message.toolCallId
        ? pendingTools.get(message.toolCallId)
        : undefined;
      if (!pending) continue;
      const text = piText(message.content);
      if (text && !pending.output)
        pending.output = truncate(text, OUTPUT_LIMIT);
      if (message.toolCallId) pendingTools.delete(message.toolCallId);
    }
  }

  return {
    harness: "pi",
    title: firstUserText ? compactLine(firstUserText) : null,
    events,
    startedAt,
    endedAt,
    activeMs: null,
    userTurns,
    toolCalls,
  };
}
