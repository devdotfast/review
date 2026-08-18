const LIBAVOID_BROWSER_MODULE =
  /[/\\]libavoid-js[/\\]dist[/\\]index\.js(?:\?.*)?$/;

const LIBAVOID_TRUSTED_TYPES_BOOTSTRAP = `
const __reviewLibavoidTrustedTypesPolicy = globalThis.trustedTypes?.createPolicy?.(
  "reviewLibavoid",
  { createScript: (value) => value },
);
function __reviewLibavoidDynamicFunction(...args) {
  const trustedArgs = args.map(
    (value) =>
      __reviewLibavoidTrustedTypesPolicy?.createScript(String(value)) ?? value,
  );
  return globalThis.Function(...trustedArgs);
}
`;

export function isLibavoidBrowserModule(moduleId: string): boolean {
  return LIBAVOID_BROWSER_MODULE.test(moduleId);
}

export function hardenLibavoidForTrustedTypes(source: string): string {
  const dynamicFunctionPattern = /\bnew Function\(/g;
  const occurrences = source.match(dynamicFunctionPattern)?.length ?? 0;
  if (occurrences === 0) {
    throw new Error(
      "libavoid browser bundle no longer contains the expected Emscripten Function constructors",
    );
  }

  return `${LIBAVOID_TRUSTED_TYPES_BOOTSTRAP}\n${source.replaceAll(
    dynamicFunctionPattern,
    "new __reviewLibavoidDynamicFunction(",
  )}`;
}
