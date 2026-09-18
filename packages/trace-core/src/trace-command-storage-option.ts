import { type Command, Option } from "commander";

/** Adds a read-only store override ; never changes persisted selection. */
export function addTraceStorageOption<T extends Command>(command: T): T {
  return command.addOption(
    new Option(
      "--storage <mode>",
      "read from the s3 or hosted store instead of the selected one",
    ).choices(["s3", "hosted"]),
  );
}
