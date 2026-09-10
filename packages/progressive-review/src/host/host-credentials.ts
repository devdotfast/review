import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type { HostPermission, HostPrincipal } from "@dev.fast/review-protocol";

import type { HostAccess } from "./review-host";
import type { ReviewHostStore } from "./review-host-store";

const AUTHOR_PERMISSIONS: HostPermission[] = [
  "read",
  "author",
  "publish",
  "register_repository",
];

/** Tokens are local-process credentials, not a claim of filesystem isolation.
 * Native human credentials are never returned by the agent discovery endpoint. */
export class HostCredentials {
  private readonly credentials: {
    digest: Buffer;
    access: HostAccess;
    onRevoked: Set<() => void>;
  }[] = [];
  readonly agentToken: string;

  constructor(store: ReviewHostStore, desktopToken: string) {
    const principal = (
      key: string,
      kind: HostPrincipal["kind"],
      displayName: string,
    ): HostPrincipal => {
      const existing = store.principal(key);
      if (existing) return existing;
      const value = { id: randomUUID(), kind, displayName };
      store.command(
        {
          clientId: "host-identity",
          commandId: randomUUID(),
          request: { key },
        },
        () => {
          store.putPrincipal(key, value);
          return value;
        },
      );
      return value;
    };
    this.add(desktopToken, {
      principal: principal("local-human", "human", "You"),
      permissions: new Set([...AUTHOR_PERMISSIONS, "human"]),
    });
    this.agentToken = randomBytes(32).toString("base64url");
    this.add(this.agentToken, {
      principal: principal("local-author", "agent", "Local author"),
      permissions: new Set(AUTHOR_PERMISSIONS),
    });
  }

  add(token: string, access: HostAccess): () => void {
    const credential = {
      digest: digest(token),
      access,
      onRevoked: new Set<() => void>(),
    };
    this.credentials.push(credential);
    return () => {
      const index = this.credentials.indexOf(credential);
      if (index < 0) return;
      this.credentials.splice(index, 1);
      for (const listener of credential.onRevoked) listener();
      credential.onRevoked.clear();
    };
  }

  authenticate(token: string | undefined): HostAccess | null {
    return this.find(token)?.access ?? null;
  }

  onRevoked(token: string | undefined, listener: () => void): () => void {
    const credential = this.find(token);
    if (!credential) {
      listener();
      return () => {};
    }
    credential.onRevoked.add(listener);
    return () => credential.onRevoked.delete(listener);
  }

  private find(token: string | undefined) {
    if (!token || token.length > 512) return null;
    const actual = digest(token);
    return (
      this.credentials.find((credential) =>
        timingSafeEqual(credential.digest, actual),
      ) ?? null
    );
  }
}

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}
