import { afterEach } from "vitest";
import { cleanup } from "vitest-browser-react";

// SAFETY: React exposes this documented test-environment flag without adding
// it to TypeScript's global declarations.
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  await cleanup();
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});
