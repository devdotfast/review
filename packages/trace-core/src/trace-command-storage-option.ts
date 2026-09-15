import { type Command, Option } from "commander";

/** Adds a read-only store override when enabled; never changes persisted selection. */
export function addTraceStorageOption<T extends Command>(
  command: T,
  enabled: boolean,
): T {
  return enabled
    ? command.addOption(
        new Option(
          "--storage <mode>",
          "read from the s3 or hosted store instead of the selected one",
        ).choices(["s3", "hosted"]),
      )
    : command;
}
