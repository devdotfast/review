import type { WhiteboardKeymapChoice } from "@dev.fast/whiteboard-protocol";
import { useState } from "react";

import type { WhiteboardComponentProps } from "../../src/whiteboard-document-data";
import { useTutorial } from "./tutorial-context";

const choices: readonly { value: WhiteboardKeymapChoice; label: string }[] = [
  { value: "none", label: "VS Code default" },
  { value: "vim", label: "Vim" },
  { value: "emacs", label: "Emacs" },
];

export function TutorialKeymapPicker(
  _props: WhiteboardComponentProps<"TutorialKeymapPicker">,
) {
  const tutorial = useTutorial();
  const [pending, setPending] = useState<WhiteboardKeymapChoice | null>(null);

  return (
    <div
      className="tutorial-keymap-picker"
      role="group"
      aria-label="Keybindings"
    >
      {choices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          aria-pressed={tutorial?.content.keymap === choice.value}
          disabled={!tutorial || pending !== null}
          onClick={() => {
            if (!tutorial) return;
            setPending(choice.value);
            void tutorial
              .selectKeymap(choice.value)
              .finally(() => setPending(null));
          }}
        >
          {pending === choice.value ? "Applying…" : choice.label}
        </button>
      ))}
    </div>
  );
}
