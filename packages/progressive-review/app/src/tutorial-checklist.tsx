import type { TutorialStepId } from "@dev.fast/review-protocol";

import { useTutorial } from "./tutorial-context";

const steps: readonly { id: TutorialStepId; label: string }[] = [
  { id: "openPeek", label: "Open a code peek" },
  { id: "gotoDefinition", label: "Jump to a definition" },
  { id: "showHover", label: "Hover for type info" },
  { id: "leaveComment", label: "Start a comment thread" },
  { id: "openSequence", label: "Walk a sequence diagram" },
  { id: "chooseKeymap", label: "Pick your keybindings" },
];

export function TutorialChecklist() {
  const tutorial = useTutorial();
  if (!tutorial || tutorial.content.progress.dismissed) return null;
  const checked = new Set(tutorial.content.progress.checked);
  const complete = steps.every((step) => checked.has(step.id));
  return (
    <aside className="tutorial-checklist" aria-label="Tutorial progress">
      <header>
        <div>
          <strong>Tutorial</strong>
          <span>
            {checked.size} of {steps.length} complete
          </span>
        </div>
        <button
          type="button"
          aria-label="Dismiss tutorial checklist"
          onClick={tutorial.dismiss}
        >
          ×
        </button>
      </header>
      <div>
        {steps.map((step) => (
          <label key={step.id}>
            <input
              type="checkbox"
              checked={checked.has(step.id)}
              onChange={(event) =>
                tutorial.setStep(step.id, event.currentTarget.checked)
              }
            />
            <span>{step.label}</span>
          </label>
        ))}
      </div>
      {complete ? (
        <footer className="tutorial-checklist-done">
          <span>That's the tour. You've seen everything Review can do.</span>
          <button type="button" onClick={tutorial.close}>
            Close the tutorial
          </button>
        </footer>
      ) : null}
    </aside>
  );
}

export function TutorialToolbarAction() {
  const tutorial = useTutorial();
  if (!tutorial || !tutorial.content.progress.dismissed) return null;
  return (
    <button
      type="button"
      className="tutorial-toolbar-action"
      onClick={tutorial.reopen}
    >
      Tutorial
    </button>
  );
}
