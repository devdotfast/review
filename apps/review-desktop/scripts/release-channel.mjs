const RELEASE_IDENTITIES = Object.freeze({
  stable: Object.freeze({
    nameShort: "Whiteboard",
    nameLong: "/dev/fast Whiteboard",
    applicationName: "review",
    dataFolderName: ".dev-fast-review",
    sharedDataFolderName: ".dev-fast-review-shared",
    darwinBundleIdentifier: "dev.fast.review",
    urlProtocol: "dev-fast-review",
    win32MutexName: "devfastreview",
    win32DirName: "Review",
    win32NameVersion: "/dev/fast Whiteboard",
    win32RegValueName: "Review",
    win32x64AppId: "{{B35E642E-885D-48BC-8386-C06377164CC5}",
    win32arm64AppId: "{{6854770A-F656-4CAC-9F4C-A50D0B97F241}",
    win32x64UserAppId: "{{78391143-AA32-4906-AF1B-54B2248A214A}",
    win32arm64UserAppId: "{{E81529AA-7A0C-43B8-956F-9DDAD5A1AA5F}",
    win32AppUserModelId: "devfast.Review",
    win32ShellNameShort: "Review",
    win32TunnelServiceMutex: "devfastreview-tunnelservice",
    win32TunnelMutex: "devfastreview-tunnel",

  }),
  preview: Object.freeze({
    nameShort: "Whiteboard Preview",
    nameLong: "/dev/fast Whiteboard Preview",
    applicationName: "review-preview",
    dataFolderName: ".dev-fast-review-preview",
    sharedDataFolderName: ".dev-fast-review-preview-shared",
    darwinBundleIdentifier: "dev.fast.review.preview",
    urlProtocol: "dev-fast-review-preview",
    win32MutexName: "devfastreviewPreview",
    win32DirName: "Review Preview",
    win32NameVersion: "/dev/fast Whiteboard Preview",
    win32RegValueName: "ReviewPreview",
    win32x64AppId: "{{D252CCAD-D236-4082-9E8D-358065D0663B}",
    win32arm64AppId: "{{63B61266-6B44-46E4-89CA-55BF1FBEBBA2}",
    win32x64UserAppId: "{{BFADA66E-FC12-452C-9F6F-09B38530CA2D}",
    win32arm64UserAppId: "{{AC7786E1-8977-4AEB-A14F-72A8E77A6EC3}",
    win32AppUserModelId: "devfast.ReviewPreview",
    win32ShellNameShort: "Review Preview",
    win32TunnelServiceMutex: "devfastreview-tunnelservicePreview",
    win32TunnelMutex: "devfastreview-tunnelPreview",

  }),
});

// Squirrel renames an install to the update's executable name, so a release
// ships one zip per bundle name still installed, each with its executable
// named to match: `bundle` is that name (the .app folder and the executable),
// `artifact` prefixes the zip file. The first entry is what a client that does
// not name its bundle receives: such a client predates the parameter, so it
// gets the pre-rename name. The DMG always carries the channel's nameShort.
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
