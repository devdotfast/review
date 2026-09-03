import type { CSSProperties, ReactElement } from "react";

import type { NormalizedSoftwareModel } from "./model";

/** The CSS length for a size prop: bare numbers are pixel counts. */
export function softwareMapCssLength(value: number | string): string {
  return Number.isFinite(value) ? `${value}px` : `${value}`;
}

export function SoftwareMapUnavailable({
  title,
  height,
  className,
}: {
  title?: string;
  height?: number | string;
  className?: string;
}): ReactElement {
  const style =
    height === undefined
      ? undefined
      : ({
          "--software-map-empty-height": softwareMapCssLength(height),
        } as CSSProperties);
  return (
    <section
      className={["software-map", className].filter(Boolean).join(" ")}
      aria-label={title ?? "Software map unavailable"}
      style={style}
    >
      <div className="software-map-unavailable">
        <h3>No software map for this repo yet</h3>
        <p>
          A software map adds a structural view of the systems, containers, and
          components in this repo.
        </p>
        <p>
          Author one with <code>review map</code>.
        </p>
        <p>The rest of the document works without it.</p>
      </div>
    </section>
  );
}

export function SoftwareMapTopologyUnavailable({
  repoSoftwareMap,
  baseSoftwareMap,
  baseRef,
  headRef,
}: {
  repoSoftwareMap: NormalizedSoftwareModel | null;
  baseSoftwareMap: NormalizedSoftwareModel | null;
  baseRef?: string;
  headRef?: string;
}): ReactElement | null {
  const missingSides = [
    ...(!baseSoftwareMap ? [softwareMapSideLabel("base", baseRef)] : []),
    ...(!repoSoftwareMap ? [softwareMapSideLabel("head", headRef)] : []),
  ];
  if (missingSides.length === 0) return null;
  return (
    <p className="software-map-topology-unavailable" role="status">
      Structural diff unavailable: no software map at{" "}
      {missingSides.join(" or ")}.
    </p>
  );
}

function softwareMapSideLabel(
  side: "base" | "head",
  ref: string | undefined,
): string {
  return ref ? `${side} ${ref}` : side;
}
