const RELEASE_IDENTITIES = Object.freeze({
  stable: Object.freeze({
    nameShort: "Whiteboard",
    nameLong: "/dev/fast Whiteboard",
    applicationName: "review",
    dataFolderName: ".dev-fast-review",
    sharedDataFolderName: ".dev-fast-review-shared",
    darwinBundleIdentifier: "dev.fast.review",
    urlProtocol: "dev-fast-review",
  }),
  preview: Object.freeze({
    nameShort: "Whiteboard Preview",
    nameLong: "/dev/fast Whiteboard Preview",
    applicationName: "review-preview",
    dataFolderName: ".dev-fast-review-preview",
    sharedDataFolderName: ".dev-fast-review-preview-shared",
    darwinBundleIdentifier: "dev.fast.review.preview",
    urlProtocol: "dev-fast-review-preview",
  }),
});

// Squirrel renames an install to the folder name inside the update zip, so a
// release ships one zip per folder name still installed: `bundle` is that
// folder name (minus .app), `artifact` prefixes the zip file. The first entry
// is what a client that does not name its folder receives: such a client
// predates the parameter, so it gets the pre-rename name. The DMG always
// carries the channel's nameShort.
const UPDATE_BUNDLES = Object.freeze({
  stable: Object.freeze([
    Object.freeze({ bundle: "Review", artifact: "Review" }),
    Object.freeze({ bundle: "Whiteboard", artifact: "Whiteboard" }),
  ]),
  preview: Object.freeze([
    Object.freeze({ bundle: "Review Preview", artifact: "Review" }),
    Object.freeze({ bundle: "Whiteboard Preview", artifact: "Whiteboard" }),
  ]),
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

export function updateBundlesFor(channel) {
  assertReleaseChannel(channel);

  return UPDATE_BUNDLES[channel];
}

export function updateZipName(artifact, version) {
  return `${artifact}-darwin-arm64-${version}.zip`;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  // `node release-channel.mjs <channel>` prints one "bundle<TAB>artifact"
  // line per update zip, for the packaging shell scripts.
  for (const { bundle, artifact } of updateBundlesFor(process.argv[2])) {
    console.log(`${bundle}\t${artifact}`);
  }
}
