// This is a blocklist, not an allowlist. `update.dev.fast` and `open-vsx.org`
// are sanctioned hosts and must stay reachable. Do not add them here when
// tightening this policy.
const BLOCKED_HOSTS = new Set([
  "aka.ms",
  "marketplace.visualstudio.com",
  "update.code.visualstudio.com",
  "vscode.blob.core.windows.net",
  "vscode.download.prss.microsoft.com",
]);

const BLOCKED_HOST_SUFFIXES = [
  ".data.microsoft.com",
  ".mai.microsoft.com",
  ".vsassets.io",
  ".vscode-cdn.net",
];

export function blockedReviewRequestReason(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(hostname)) {
    return `blocked service host ${hostname}`;
  }
  const suffix = BLOCKED_HOST_SUFFIXES.find(
    (candidate) =>
      hostname === candidate.slice(1) || hostname.endsWith(candidate),
  );
  if (suffix) {
    return `blocked service host ${hostname}`;
  }
  if (
    hostname === "api.github.com" &&
    /^\/copilot(?:_internal)?(?:\/|$)/.test(url.pathname)
  ) {
    return `blocked Copilot endpoint ${url.pathname}`;
  }
  return undefined;
}

export function assertNoBlockedReviewRequests(requestUrls) {
  const blocked = [
    ...new Map(
      requestUrls.flatMap((url) => {
        const reason = blockedReviewRequestReason(url);
        return reason ? [[url, reason]] : [];
      }),
    ),
  ].sort(([left], [right]) => left.localeCompare(right));

  if (blocked.length === 0) return;
  throw new Error(
    [
      "Review Desktop contacted disabled Microsoft or Copilot services:",
      ...blocked.map(([url, reason]) => `- ${reason}: ${url}`),
    ].join("\n"),
  );
}
