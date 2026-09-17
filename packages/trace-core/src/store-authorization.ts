import { AsyncLocalStorage } from "node:async_hooks";

type AuthorizationScope = {
  authorize: (origin: string) => Promise<string | undefined>;
  attempted: boolean;
};

const context = new AsyncLocalStorage<AuthorizationScope>();

/** Only a foreground CLI installs this callback; hooks never prompt. */
export function withStoreAuthorization<T>(
  authorize: AuthorizationScope["authorize"],
  operation: () => Promise<T>,
): Promise<T> {
  return context.run({ authorize, attempted: false }, operation);
}

export async function requestStoreAuthorization(origin: string) {
  const scope = context.getStore();

  if (!scope || scope.attempted) return undefined;
  scope.attempted = true;

  return scope.authorize(origin);
}
