import type { ReviewKeymapChoice } from "@dev.fast/review-protocol";
import { useState } from "react";

import type { TutorialKeymapPickerProps } from "../../src/authoring";
import { useTutorial } from "./tutorial-context";

const choices: readonly { value: ReviewKeymapChoice; label: string }[] = [
  { value: "none", label: "VS Code default" },
  { value: "vim", label: "Vim" },
  { value: "emacs", label: "Emacs" },
];

export function TutorialKeymapPicker(_props: TutorialKeymapPickerProps) {
  const tutorial = useTutorial();
  const [pending, setPending] = useState<ReviewKeymapChoice | null>(null);
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
          {pending === choice.value
            ? "Applying…"
            : tutorial?.content.keymap === choice.value
              ? `${choice.label} ✓`
              : choice.label}
        </button>
      ))}
    </div>
  );
}
