// Cleans a free-text telemetry value: replaces paths, web addresses, e-mail
// addresses, and known secret formats with labelled markers.
//
// PROVENANCE. This is a port of Microsoft's implementation in VS Code, which
// this product is a fork of. Source:
//   apps/review-desktop/code-oss/src/vs/platform/telemetry/common/telemetryUtils.ts
//   (`anonymizeFilePaths`, `userDataRegexes`, `redactIfPossibleUserInfo`,
//    `removePropertiesWithPossibleUserInfo`)
// Licensed under the MIT License, Copyright (c) Microsoft Corporation.
//
// It lives here rather than being imported because the local Review server and
// the canvas both need it and neither can reach into the vendored VS Code tree.
// Keep it a FAITHFUL copy: upstream comments and expressions are preserved
// verbatim so a later reader can diff this file against upstream and see at a
// glance whether it has drifted. Behaviour changes belong in the caller.
//
// The functions are pure and free of Node imports, so the browser-safe event
// allowlist can share the expression list for its own independent re-check.
//
// DEVIATIONS FROM UPSTREAM, and only these:
//  - Upstream keeps the tail of a `.vscode*/extensions/…` path so a stack stays
//    attributable to an extension. Review reports no extension-host errors and
//    cleans a message rather than a stack, so that branch is dropped and such a
//    path is replaced whole. The `node_modules` branch is kept: a message can
//    name a module usefully.
//  - `cleanData`, upstream's object walker, is not ported. Review cleans two
//    known strings, so walking an arbitrary object is not needed, and not
//    having it means there is no path by which an unreviewed property could be
//    cleaned-and-forwarded.

export const USER_DATA_REGEXES = [
  { label: "URL", regex: /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]*/ },
  { label: "Google API Key", regex: /AIza[A-Za-z0-9_\\\-]{35}/ },
  {
    label: "JWT",
    regex:
      /eyJ[0eXAiOiJKV1Qi|hbGci|a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+/,
  },
  { label: "Slack Token", regex: /xox[pbar]\-[A-Za-z0-9]/ },
  {
    label: "GitHub Token",
    regex:
      /(gh[psuro]_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59})/,
  },
  {
    label: "Generic Secret",
    regex:
      /(key|token|sig|secret|signature|password|passwd|pwd|android:value)[^a-zA-Z0-9]/i,
  },
  {
    label: "CLI Credentials",
    regex:
      /((login|psexec|(certutil|psexec)\.exe).{1,50}(\s-u(ser(name)?)?\s+.{3,100})?\s-(admin|user|vm|root)?p(ass(word)?)?\s+["']?[^$\-\/\s]|(^|[\s\r\n\\])net(\.exe)?.{1,5}(user\s+|share\s+\/user:| user -? secrets ? set) \s + [^ $\s \/])/,
  },
  {
    label: "Microsoft Entra ID",
    regex: /eyJ(?:0eXAiOiJKV1Qi|hbGci|[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+\.)/,
  },
  { label: "Email", regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/ },
] as const;

const REDACTED_PATH_MARKER = "<REDACTED: user-file-path>";

/**
 * The path shape the cleaner replaces: one or more `segment/` runs, with an
 * optional drive letter, UNC, or `file://` root. Upstream keeps this inline in
 * `anonymizeFilePaths`; it is named here so the allowlist can assert that no
 * path shape survived cleaning.
 */
const FILE_PATH_SHAPE =
  /(file:\/\/)?([a-zA-Z]:(\\\\|\\|\/)|(\\\\|\\|\/))?([\w\-\._@]+(\\\\|\\|\/))+[\w\-\._@]*/;

/**
 * True when the value still holds something path-shaped. Deliberately the same
 * definition the cleaner uses: the point of re-testing is not a second opinion
 * on what a path looks like, it is to catch the cleaner failing to apply its own
 * rule — wrong patterns, wrong order, or an exception swallowed on the way.
 */
export function containsFilePathShape(value: string): boolean {
  return FILE_PATH_SHAPE.test(value);
}

/**
 * True when the value still holds something the cleaner should have replaced.
 * The event allowlist calls this as its own second check, so it must not depend
 * on the cleaner having run.
 */
export function hasPossibleUserInfo(value: string): boolean {
  return USER_DATA_REGEXES.some((entry) => entry.regex.test(value));
}

/**
 * Cleans a given stack of possible paths
 * @param stack The stack to sanitize
 * @param cleanupPatterns Cleanup patterns to remove from the stack
 * @returns The cleaned stack
 */
export function anonymizeFilePaths(
  stack: string,
  cleanupPatterns: RegExp[],
): string {
  // Fast check to see if it is a file path to avoid doing unnecessary heavy regex work
  if (!stack || (!stack.includes("/") && !stack.includes("\\"))) {
    return stack;
  }

  let updatedStack = stack;

  const cleanUpIndexes: [number, number][] = [];
  for (const regexp of cleanupPatterns) {
    while (true) {
      const result = regexp.exec(stack);
      if (!result) {
        break;
      }
      cleanUpIndexes.push([result.index, regexp.lastIndex]);
    }
  }

  // Match node_modules or node_modules.asar at any position in the path, capturing the node_modules/... suffix
  const nodeModulesRegex =
    /(?:^|[\\\/])((node_modules|node_modules\.asar)[\\\/].*)$/;
  const fileRegex =
    /(file:\/\/)?([a-zA-Z]:(\\\\|\\|\/)|(\\\\|\\|\/))?([\w\-\._@]+(\\\\|\\|\/))+[\w\-\._@]*/g;
  let lastIndex = 0;
  updatedStack = "";

  while (true) {
    const result = fileRegex.exec(stack);
    if (!result) {
      break;
    }

    // Check to see if the any cleanupIndexes partially overlap with this match
    const overlappingRange = cleanUpIndexes.some(
      ([start, end]) => result.index < end && start < fileRegex.lastIndex,
    );

    // anoynimize user file paths that do not need to be retained or cleaned up.
    if (!overlappingRange) {
      // Check if node_modules appears in the path — preserve node_modules/... suffix
      const nodeModulesMatch = nodeModulesRegex.exec(result[0]);
      if (nodeModulesMatch) {
        updatedStack +=
          stack.substring(lastIndex, result.index) +
          `${REDACTED_PATH_MARKER}/` +
          nodeModulesMatch[1];
      } else {
        updatedStack +=
          stack.substring(lastIndex, result.index) + REDACTED_PATH_MARKER;
      }
      lastIndex = fileRegex.lastIndex;
    }
  }
  if (lastIndex < stack.length) {
    updatedStack += stack.substring(lastIndex);
  }

  return updatedStack;
}

/**
 * Redacts a value if it contains commonly leaked PII.
 * @param value The value returned (as-is) when no PII is detected
 * @param probe The string actually matched against the PII heuristics. Defaults
 * to `value`; callers may pass a value that includes a trailing delimiter (e.g. a
 * newline) so that heuristics relying on a non-alphanumeric boundary match the
 * same way they would against the original whole string.
 * @returns A `<REDACTED: ...>` marker if the probe matched, otherwise `value`
 */
function redactIfPossibleUserInfo(value: string, probe: string = value): string {
  for (const secretRegex of USER_DATA_REGEXES) {
    if (secretRegex.regex.test(probe)) {
      return `<REDACTED: ${secretRegex.label}>`;
    }
  }
  return value;
}

/**
 * Attempts to remove commonly leaked PII.
 *
 * When a match is found the check is applied per line so that a single suspicious
 * frame (e.g. a stack frame containing a function name such as `getStorageKey`
 * which matches the broad `Generic Secret` heuristic) only redacts that line —
 * replacing it with a `<REDACTED: ...>` marker — instead of wiping the entire
 * multi-line value such as a whole callstack.
 * @param property The property whose offending lines will be replaced with a redaction marker if they contain user data
 * @returns The new value for the property
 */
export function removePropertiesWithPossibleUserInfo(property: string): string {
  // If for some reason it is undefined we skip it (this shouldn't be possible);
  if (!property) {
    return property;
  }

  // Fast path: if nothing matches we return the value untouched without
  // allocating.
  if (!hasPossibleUserInfo(property)) {
    return property;
  }

  // Single line values keep the original behavior of redacting the whole value.
  if (!property.includes("\n")) {
    return redactIfPossibleUserInfo(property);
  }

  // Multi-line values (e.g. callstacks) are redacted line-by-line so we only
  // drop the offending lines and preserve the rest of the information.
  const lines = property.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const probe = i < lines.length - 1 ? lines[i] + "\n" : lines[i];
    lines[i] = redactIfPossibleUserInfo(lines[i], probe);
  }
  return lines.join("\n");
}

/**
 * The whole pipeline for one free-text value, in VS Code's order: replace
 * path-shaped runs, delete the known local directories outright, then replace
 * any line holding a secret or address shape.
 */
export function cleanTelemetryText(
  value: string,
  cleanupPatterns: RegExp[],
): string {
  let updated = value.replaceAll("%20", " ");
  updated = anonymizeFilePaths(updated, cleanupPatterns);
  for (const regexp of cleanupPatterns) {
    updated = updated.replace(regexp, "");
  }
  return removePropertiesWithPossibleUserInfo(updated);
}

// `cleanupPatterns` above is the list of directories to delete outright rather
// than replace with a marker. Upstream builds it from five known directories;
// Review always passes an empty list, so what remains is the overlap check
// inherited from upstream. See NO_DELETED_DIRECTORIES in error-telemetry.ts for
// why. Should Review ever need the list, upstream builds it inline in
// telemetryService.ts with escaped, case-insensitive, global patterns.
