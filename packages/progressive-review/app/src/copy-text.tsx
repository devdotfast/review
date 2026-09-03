export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // The workbench denies DOM clipboard permission requests.
  }
  const active = document.activeElement;
  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.style.position = "fixed";
  scratch.style.opacity = "0";
  document.body.appendChild(scratch);
  scratch.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    // The caller keeps its default label when the copy fails.
  }
  scratch.remove();
  if (active instanceof HTMLElement) active.focus();
  return copied;
}

export function CopyIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1" />
      <path d="M8.5 3.5v-1a1 1 0 0 0-1-1h-5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h1" />
    </svg>
  );
}
