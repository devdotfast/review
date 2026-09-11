import {
  HOST_LIMITS,
  HOST_SUPPORT_LIMITS,
  type HostBugReportInput,
  HostBugReportInputSchema,
  HostBugReportResultSchema,
  HostDocumentStateSchema,
  HostDocumentValidationError,
  HostReviewWithSnapshotSchema,
  type HostSupportWarning,
} from "@dev.fast/review-protocol";
import sharp from "sharp";

import { readProgressiveReviewPackageVersion } from "../package-paths";
import { reviewDiffFilesFromPatch } from "../review-diff-files";
import {
  type BugReportPayload,
  BugReportUpstreamError,
  submitBugReportPayload,
} from "../server/bug-report";
import { EvidenceProviderError } from "./evidence-provider";
import { LocalRepositorySource } from "./local-repository";
import {
  type HostAccess,
  HostAccessError,
  type ReviewHost,
} from "./review-host";

/** Reports are observations of one immutable snapshot, with separate consent
 * for each attachment. They never read a latest map or an author transcript. */
export async function submitHostBugReport(input: {
  host: ReviewHost;
  access: HostAccess;
  workspaceId: string;
  reviewId: string;
  body: HostBugReportInput;
  fetchImpl?: typeof fetch;
}) {
  const { host, access, workspaceId, reviewId } = input;
  if (access.principal.kind !== "human" || !access.permissions.has("human"))
    throw new HostAccessError(
      "FORBIDDEN",
      "Only a person can submit a bug report.",
    );
  const body = HostBugReportInputSchema.parse(input.body);
  const request = {
    apiVersion: 1 as const,
    hostId: host.store.hostId,
    workspaceId,
    clientId: access.principal.id,
  };
  // The standard read path applies review-scoped credentials before acquisition.
  const { snapshot } = HostReviewWithSnapshotSchema.parse(
    (
      await host.query(access, {
        ...request,
        type: "review.get",
        input: { reviewId, reviewVersion: body.reviewVersion },
      })
    ).result,
  );
  const { report } = body;
  if (report.screenshot) await validateScreenshot(report.screenshot.base64);
  const payload: BugReportPayload = {
    schema_version: 4,
    description: report.description,
    diagnostics: {
      app_version: report.app_version,
      cli_version: readProgressiveReviewPackageVersion(),
      platform: process.platform,
      app_session_id: report.app_session_id,
      client_error_names: [],
    },
  };
  const warnings: HostSupportWarning[] = [];
  const warn = (
    attachment: HostSupportWarning["attachment"],
    code: HostSupportWarning["code"],
  ) => {
    warnings.push({
      attachment,
      code,
      message:
        code === "size_limit"
          ? `The ${attachment} attachment was omitted because it exceeded the report size limit.`
          : `The ${attachment} attachment was unavailable for this saved review version.`,
    });
  };
  if (report.screenshot) payload.screenshot = report.screenshot;
  if (report.include_review || report.include_map) {
    try {
      const document = HostDocumentStateSchema.parse(
        (
          await host.query(access, {
            ...request,
            type: "document.get",
            input: { reviewId, reviewVersion: body.reviewVersion },
          })
        ).result,
      );
      if (report.include_review)
        payload.review = {
          "review.json": JSON.stringify(snapshot),
          "document.json": JSON.stringify(document),
        };
      if (report.include_map) {
        try {
          const mapIds = new Set(
            Object.values(document.nodes).flatMap((node) =>
              node.type === "software_map" ? [node.mapVersionId] : [],
            ),
          );
          for (const id of [
            snapshot.mapVersions.base,
            snapshot.mapVersions.head,
          ])
            if (id) mapIds.add(id);
          const maps = [...mapIds].map((id) =>
            host.store.mapVersion(reviewId, id),
          );
          if (maps.length) payload.map = JSON.stringify(maps);
        } catch {
          warn("map", "unavailable");
        }
      }
    } catch {
      if (report.include_review) warn("review", "unavailable");
      if (report.include_map) warn("map", "unavailable");
    }
  }
  if (report.include_diff) {
    try {
      const source = new LocalRepositorySource((id) =>
        host.store.repositoryPath(id),
      );
      const patch = await source.analysisPatch(snapshot.binding);
      payload.diff = {
        baseRef: snapshot.binding.baseCommit,
        headRef: snapshot.binding.headCommit,
        files: reviewDiffFilesFromPatch(patch),
      };
    } catch (error) {
      warn(
        "diff",
        error instanceof EvidenceProviderError &&
          error.code === "RESOURCE_LIMIT"
          ? "size_limit"
          : "unavailable",
      );
    }
  }
  const attached = (["review", "map", "diff", "screenshot"] as const).filter(
    (name) => payload[name] !== undefined,
  );
  // The common uploader makes one attempt and removes over-budget attachments
  // in-place before sending. Surface those omissions instead of silent success.
  const result = await submitBugReportPayload({
    payload,
    fetchImpl: input.fetchImpl,
  });
  for (const attachment of attached)
    if (payload[attachment] === undefined) warn(attachment, "size_limit");
  const receipt = HostBugReportResultSchema.safeParse({
    reportId: result.report_id,
    shortId: result.short_id,
    warnings,
  });
  if (!receipt.success)
    throw new BugReportUpstreamError(
      502,
      "The support service returned an invalid receipt.",
    );
  return receipt.data;
}

async function validateScreenshot(base64: string) {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64)
    invalidScreenshot("Screenshot must use canonical base64.");
  if (bytes.length > HOST_SUPPORT_LIMITS.screenshotBytes)
    throw new EvidenceProviderError(
      "RESOURCE_LIMIT",
      "Screenshot exceeds 3 MiB.",
    );
  try {
    const image = sharp(bytes, {
      failOn: "warning",
      limitInputPixels: HOST_LIMITS.assetPixels,
    });
    const metadata = await image.metadata();
    if (
      metadata.format !== "jpeg" ||
      !metadata.width ||
      !metadata.height ||
      (metadata.pages ?? 1) !== 1
    )
      invalidScreenshot("Screenshot must be one complete JPEG image.");
    await image.raw().toBuffer();
  } catch (error) {
    if (error instanceof HostDocumentValidationError) throw error;
    invalidScreenshot(
      "Screenshot could not be decoded as a complete JPEG image.",
    );
  }
}
function invalidScreenshot(message: string): never {
  throw new HostDocumentValidationError([
    {
      severity: "error",
      code: "INVALID_SCREENSHOT",
      message,
      path: "/input/report/screenshot",
    },
  ]);
}
