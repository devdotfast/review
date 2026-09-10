import type { Readable, Writable } from "node:stream";

import {
  HOST_COMMAND_DEFINITIONS,
  HOST_LIMITS,
  HOST_QUERY_DEFINITIONS,
  HOST_RESOURCE_LIMITS,
  type HostCommandName,
  type HostQueryName,
  type JsonValue,
  ReviewClientError,
  parseJsonText,
} from "@dev.fast/review-protocol";

import { LocalHostClient, describeHostClientError } from "./host-discovery";

type HostClientFlag = "input" | "command-id" | "client-id" | "review";
type HostClientFlags = Partial<Record<HostClientFlag, string>>;

const help = `Review JSON host client (Desktop must already be running)

review host capabilities
review host connection
review host query <operation> --input '<json>'
review host command <operation> --command-id <uuid> --input '<json>'
review host open --review <uuid>
review mcp [--client-id <uuid>]

Use --input - to read bounded JSON from stdin. Commands require a caller-chosen
command ID; reuse it when retrying a lost response. --client-id is optional.
All results are JSON. This client never starts or delegates to an installed app.
`;

export async function runHostCli(options: {
  argv: string[];
  stdin: Readable;
  stdout: Pick<Writable, "write">;
  stderr: Pick<Writable, "write">;
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  let commandId: string | undefined;
  try {
    if (options.argv.length === 0 || options.argv.includes("--help")) {
      options.stdout.write(help);
      return 0;
    }
    const [action, ...rest] = options.argv;
    const operation =
      action === "command" || action === "query" ? rest.shift() : undefined;
    const flags = parseHostClientFlags(rest, [
      "input",
      "command-id",
      "client-id",
      "review",
    ]);
    commandId = flags["command-id"];
    const client = new LocalHostClient({
      env: options.env,
      clientId: flags["client-id"],
    });
    let result: object;
    if (action === "connection") {
      requireFlags(flags, ["client-id"]);
      result = await client.connection();
    } else if (action === "capabilities") {
      requireFlags(flags, ["client-id"]);
      result = await client.query("capabilities", {});
    } else if (action === "open") {
      requireFlags(flags, ["review", "client-id"]);
      if (!flags.review) invalid("Opening a review requires --review <uuid>.");
      result = await client.open(flags.review);
    } else if (action === "command") {
      requireFlags(flags, ["input", "command-id", "client-id"]);
      if (!operation || !isHostCommandName(operation))
        invalid(
          "Unknown Review host command. Use capabilities to list operations.",
        );
      if (!commandId)
        invalid(
          "Commands require --command-id <uuid>. Keep that ID to retry a lost response.",
        );
      const input = HOST_COMMAND_DEFINITIONS[operation].input.parse(
        await readInput(
          flags.input,
          options.stdin,
          operation === "asset.upload"
            ? HOST_RESOURCE_LIMITS.assetUploadRequestBytes
            : HOST_LIMITS.commandBytes,
        ),
      );
      result = await client.command(operation, input, { commandId });
    } else if (action === "query") {
      requireFlags(flags, ["input", "client-id"]);
      if (!operation || !isHostQueryName(operation))
        invalid(
          "Unknown Review host query. Use capabilities to list operations.",
        );
      const input = HOST_QUERY_DEFINITIONS[operation].input.parse(
        await readInput(flags.input, options.stdin),
      );
      result = await client.query(operation, input);
    } else invalid("Unknown host action. Use review host --help.");
    options.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
    return 0;
  } catch (error) {
    const detail =
      error instanceof Error
        ? describeHostClientError(error)
        : {
            code: "INTERNAL",
            message: "The Review client failed unexpectedly.",
            retryable: false,
            diagnostics: [],
          };
    options.stderr.write(
      `${JSON.stringify({ ok: false, error: detail, commandId })}\n`,
    );
    return 1;
  }
}

export function parseHostClientFlags(
  argv: string[],
  allowed: HostClientFlag[],
): HostClientFlags {
  const result: HostClientFlags = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const name = allowed.find((candidate) => flag === `--${candidate}`);
    const value = argv[index + 1];
    if (!name || value === undefined || Object.hasOwn(result, name))
      invalid(
        "Expected one value for each supported flag. Use review host --help.",
      );
    result[name] = value;
  }
  return result;
}

export function isHostCommandName(value: string): value is HostCommandName {
  return Object.hasOwn(HOST_COMMAND_DEFINITIONS, value);
}
export function isHostQueryName(value: string): value is HostQueryName {
  return Object.hasOwn(HOST_QUERY_DEFINITIONS, value);
}

function requireFlags(flags: HostClientFlags, allowed: HostClientFlag[]) {
  if (
    Object.keys(flags).some(
      (name) => !allowed.some((candidate) => candidate === name),
    )
  )
    invalid(
      "A flag does not apply to this host action. Use review host --help.",
    );
}

async function readInput(
  value: string | undefined,
  stdin: Readable,
  limit = HOST_LIMITS.commandBytes,
): Promise<JsonValue> {
  if (value === undefined) invalid("Provide --input '<json>' or --input -.");
  if (value === "-") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += bytes.length;
      if (size > limit)
        invalid("The input exceeds the Review command byte limit.");
      chunks.push(bytes);
    }
    value = Buffer.concat(chunks).toString("utf8");
  }
  if (Buffer.byteLength(value) > limit)
    invalid("The input exceeds the Review command byte limit.");
  try {
    return parseJsonText(value);
  } catch {
    return invalid("The input must be valid JSON.");
  }
}

function invalid(message: string): never {
  throw new ReviewClientError({
    code: "INVALID_REQUEST",
    message,
    retryable: false,
    diagnostics: [],
  });
}
