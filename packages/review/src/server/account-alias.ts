import { StoreClient, readStoreAuth } from "@dev.fast/trace-core";

import type { ReviewTelemetry } from "../review-telemetry";

/**
 * After a login, link this install to the signed-in account by a hash of its
 * account id. Best effort and never throws: the login already succeeded.
 */
export async function aliasInstallationToAccount(
  telemetry: Pick<ReviewTelemetry, "captureAccountAlias">,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): Promise<void> {
  try {
    const auth = await readStoreAuth(env);

    if (!auth) return;

    await telemetry.captureAccountAlias(async () => {
      const session = await new StoreClient({
        origin: auth.origin,
        token: auth.token,
        fetch: fetchImpl,
      }).session();

      return session.user.id;
    });
  } catch {
    // No alias this time; the next login tries again.
  }
}
