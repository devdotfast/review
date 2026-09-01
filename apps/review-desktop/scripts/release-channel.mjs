const RELEASE_IDENTITIES = Object.freeze({
  stable: Object.freeze({
    nameShort: "Review",
    nameLong: "/dev/fast Review",
    applicationName: "review",
    dataFolderName: ".dev-fast-review",
    sharedDataFolderName: ".dev-fast-review-shared",
    darwinBundleIdentifier: "dev.fast.review",
    urlProtocol: "dev-fast-review",
  }),
  preview: Object.freeze({
    nameShort: "Review Preview",
    nameLong: "/dev/fast Review Preview",
    applicationName: "review-preview",
    dataFolderName: ".dev-fast-review-preview",
    sharedDataFolderName: ".dev-fast-review-preview-shared",
    darwinBundleIdentifier: "dev.fast.review.preview",
    urlProtocol: "dev-fast-review-preview",
  }),
});

export function assertReleaseChannel(channel) {
  if (!Object.hasOwn(RELEASE_IDENTITIES, channel)) {
    throw new Error(
      `channel must be one of stable or preview, received ${JSON.stringify(channel)}`,
    );
  }
}

export function releaseIdentityFor(channel) {
  assertReleaseChannel(channel);
  return RELEASE_IDENTITIES[channel];
}
