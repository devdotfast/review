/** Lowercase ASCII slug: runs of anything but `a-z0-9` become one `-`, outer
 * dashes go. Empty input, or input with no letters or digits, yields `""`;
 * callers choose their own fallback (`"section"`, `"diagram"`, `"database"`).
 * This is the rule sequence and lens ids were already published with, so it
 * must not change. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** First of `base`, `base-2`, `base-3`, … not present in `used`. */
export function uniqueId(base: string, used: ReadonlySet<string>): string {
  let candidate = base;

  for (let suffix = 2; used.has(candidate); suffix += 1) {
    candidate = `${base}-${suffix}`;
  }

  return candidate;
}
