import { afterEach } from "vitest";

// SAFETY: React exposes this documented test-environment flag without adding
// it to TypeScript's global declarations.
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});
