import { z } from "zod";

export const SHARE_FORMAT = "review-share/1";

export const MAX_SHARE_MANIFEST_BYTES = 2 * 1024 * 1024;

export const MAX_SHARE_OBJECT_BYTES = 32 * 1024 * 1024;

export const MAX_SHARE_BYTES = 128 * 1024 * 1024;

export const MAX_SHARE_OBJECTS = 2048;

export const objectIdSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const shareIdSchema = z.uuid();

export const capabilitySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const shareObjectSchema = z
  .strictObject({
    id: objectIdSchema,
    size: z.number().int().min(0).max(MAX_SHARE_OBJECT_BYTES),
    sha256: objectIdSchema,
  })
  .refine(
    (object) => object.id === object.sha256,
    "Object ID must match its digest.",
  );

export const sharePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (file) =>
      !file.startsWith("/") &&
      !file.includes("\\") &&
      !/[\u0000-\u001f\u007f]/.test(file) &&
      file
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "Use a repository-relative file path.",
  );

/** The published identity is independent of the author's credential transport. */
export function normalizeGitHubRemote(remote: string): string {
  const url = new URL(
    remote.trim().replace(/^git@github\.com:/, "https://github.com/"),
  );

  if (
    !["https:", "ssh:"].includes(url.protocol) ||
    url.hostname !== "github.com" ||
    url.port ||
    url.search ||
    url.hash ||
    (url.protocol === "ssh:" && url.username !== "git")
  )
    throw new Error("Sharing requires a GitHub repository remote.");

  const parts = url.pathname
    .replace(/\.git$/, "")
    .split("/")
    .slice(1);

  if (
    parts.length !== 2 ||
    parts.some(
      (part) =>
        !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === "..",
    )
  )
    throw new Error("Sharing requires a GitHub repository remote.");

  return `https://github.com/${parts.join("/")}.git`;
}

export const gitHubRepositoryUrlSchema = z.string().refine((value) => {
  try {
    return normalizeGitHubRemote(value) === value;
  } catch {
    return false;
  }
}, "Use a canonical GitHub HTTPS repository URL without credentials.");

export const shareManifestSchema = z
  .strictObject({
    format: z.literal(SHARE_FORMAT),
    sessionId: z.string().min(1).max(256),
    version: z.number().int().nonnegative(),
    title: z.string().min(1).max(4096),
    snapshot: objectIdSchema,
    presentation: objectIdSchema,
    objects: z.array(shareObjectSchema).min(2).max(MAX_SHARE_OBJECTS),
    resources: z
      .array(
        z.strictObject({
          id: z.string().min(1).max(256),
          kind: z.enum(["image", "trace", "map"]),
          mimeType: z.enum(["image/png", "application/json"]),
          object: objectIdSchema,
        }),
      )
      .max(MAX_SHARE_OBJECTS),
    repository: z.strictObject({ cloneUrl: gitHubRepositoryUrlSchema }),
  })
  .superRefine((manifest, context) => {
    const ids = new Set(manifest.objects.map((object) => object.id));

    const fail = (message: string) =>
      context.addIssue({ code: "custom", message });

    if (ids.size !== manifest.objects.length) fail("Duplicate object ID.");

    if (
      manifest.objects.reduce((size, object) => size + object.size, 0) >
      MAX_SHARE_BYTES
    )
      fail("Share exceeds the total byte limit.");

    for (const id of [
      manifest.snapshot,
      manifest.presentation,
      ...manifest.resources.map((resource) => resource.object),
    ])
      if (!ids.has(id)) fail("Reference to an undeclared object.");

    if (
      new Set(manifest.resources.map((resource) => resource.id)).size !==
      manifest.resources.length
    )
      fail("Duplicate resource ID.");

    for (const resource of manifest.resources)
      if ((resource.kind === "image") !== (resource.mimeType === "image/png"))
        fail("Resource MIME type does not match its kind.");
  });

/** Only import/download paths accept manifests published before the rename. */
export const importedShareManifestSchema = z.union([
  shareManifestSchema,
  z
    .object({ reviewId: z.string() })
    .passthrough()
    .refine(
      (value) => !("sessionId" in value),
      "Conflicting session identifiers.",
    )
    .transform(({ reviewId, ...rest }) => ({ ...rest, sessionId: reviewId }))
    .pipe(shareManifestSchema),
]);

export type ShareManifest = z.infer<typeof shareManifestSchema>;

export type ShareObject = z.infer<typeof shareObjectSchema>;

export const createShareSchema = z.strictObject({
  requestId: z.uuid(),
  manifest: z.strictObject({
    sha256: objectIdSchema,
    size: z.number().int().positive().max(MAX_SHARE_MANIFEST_BYTES),
  }),
});

export function shareLink(
  origin: string,
  id: string,
  capability: string,
): string {
  return new URL(
    `/s/${shareIdSchema.parse(id)}#${capabilitySchema.parse(capability)}`,
    origin,
  ).href;
}

export function parseShareLink(value: string) {
  const url = new URL(value);

  if (url.protocol !== "https:" || url.username || url.password || url.search)
    throw new Error("Use an HTTPS Review share link.");
  const match = /^\/s\/([^/]+)$/.exec(url.pathname);

  return {
    origin: url.origin,
    shareId: shareIdSchema.parse(match?.[1]),
    capability: capabilitySchema.parse(url.hash.slice(1)),
  };
}
