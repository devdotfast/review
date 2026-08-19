import { z } from "zod";

// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------

export const TRACE_PROTOCOL_VERSION = 1;
export const TRACE_API_VERSION_HEADER = "x-trace-api-version";

// Upload blobs record the scrub pass applied before upload. 0 = none.
export const TRACE_SCRUB_VERSION = 0;

// ---------------------------------------------------------------------------
// Core value schemas
// ---------------------------------------------------------------------------

export const ownerSchema = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/)
  .transform((value) => value.toLowerCase());
export const repoSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/)
  .transform((value) => value.toLowerCase());

export const sessionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/);

export const commitShaSchema = z.string().regex(/^[0-9a-f]{40,64}$/);

export const traceAccessSchema = z.enum(["read", "write"]);
export type TraceAccess = z.infer<typeof traceAccessSchema>;

// ---------------------------------------------------------------------------
// Stored object shapes (byte-compatible with the internal R2 layout)
// ---------------------------------------------------------------------------

export const byCommitSchema = z.object({
  commit: commitShaSchema,
  sessions: z.array(sessionIdSchema),
  repo: z.string(),
  pr: z.number().int().nullable(),
  branch: z.string().nullable(),
  indexed_by: z.enum(["hook", "ci"]),
  ts: z.string(),
});
export type ByCommitEntry = z.infer<typeof byCommitSchema>;

export const sessionMetaSchema = z.object({
  session: sessionIdSchema,
  repo: z.string().nullable(),
  branch: z.string().nullable(),
  pr: z.number().int().nullable(),
  commits: z.array(commitShaSchema),
  author: z.string().nullable(),
  ts: z.string(),
});
export type SessionMeta = z.infer<typeof sessionMetaSchema>;

// ---------------------------------------------------------------------------
// API request/response shapes
// ---------------------------------------------------------------------------

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export const uploadTraceResponseSchema = z.object({
  ok: z.literal(true),
  bytes_stored: z.number().int().nonnegative(),
  stored: z.enum(["written", "unchanged"]),
});
export type UploadTraceResponse = z.infer<typeof uploadTraceResponseSchema>;

export const postSessionMetaRequestSchema = sessionMetaSchema
  .omit({ ts: true })
  .partial({ repo: true, branch: true, pr: true, author: true })
  .extend({ commits: z.array(commitShaSchema).default([]) });
export type PostSessionMetaRequest = z.infer<
  typeof postSessionMetaRequestSchema
>;

export const postCommitRequestSchema = byCommitSchema.omit({ ts: true });
export type PostCommitRequest = z.infer<typeof postCommitRequestSchema>;

export const mintTokenRequestSchema = z.object({
  owner: ownerSchema,
  repo: repoSchema,
  access: traceAccessSchema,
});
export const mintTokenResponseSchema = z.object({
  token: z.string(),
  expires_at: z.string(),
});
export type MintTokenResponse = z.infer<typeof mintTokenResponseSchema>;

// ---------------------------------------------------------------------------
// Capability tokens
// ---------------------------------------------------------------------------

export const traceTokenPayloadSchema = z.object({
  owner: ownerSchema,
  repo: repoSchema,
  access: traceAccessSchema,
  exp: z.number().int(),
});
export type TraceTokenPayload = z.infer<typeof traceTokenPayloadSchema>;

export interface CreateSignedTraceTokenInput {
  owner: string;
  repo: string;
  access: TraceAccess;
  expiresAt: Date;
  secret: string;
}

export async function createSignedTraceToken(
  input: CreateSignedTraceTokenInput,
): Promise<string> {
  const payload: TraceTokenPayload = traceTokenPayloadSchema.parse({
    owner: input.owner,
    repo: input.repo,
    access: input.access,
    exp: Math.floor(input.expiresAt.getTime() / 1000),
  });
  const encoded = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signature = await signTraceTokenPayload(encoded, input.secret);

  return `v1.${encoded}.${signature}`;
}

export interface VerifySignedTraceTokenInput {
  token: string;
  secret: string;
  now?: Date;
}

export async function verifySignedTraceToken(
  input: VerifySignedTraceTokenInput,
): Promise<TraceTokenPayload | null> {
  const parts = input.token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    return null;
  }
  const [, encoded, signature] = parts;

  const expectedSignature = await signTraceTokenPayload(encoded, input.secret);
  if (!timingSafeEqual(signature, expectedSignature)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded)));
  } catch {
    return null;
  }
  const payload = traceTokenPayloadSchema.safeParse(parsed);
  if (!payload.success) {
    return null;
  }

  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (payload.data.exp < nowSeconds) {
    return null;
  }

  return payload.data;
}

// ---------------------------------------------------------------------------
// Internal crypto helpers
// ---------------------------------------------------------------------------

async function signTraceTokenPayload(
  payload: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  );

  return base64UrlEncode(new Uint8Array(signature));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(encoded: string): Uint8Array {
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function timingSafeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return diff === 0;
}
