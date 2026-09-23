import type { Hooks } from "@opencode-ai/plugin";

export default function whiteboardPlugin(): Promise<
  Required<Pick<Hooks, "config">>
>;
