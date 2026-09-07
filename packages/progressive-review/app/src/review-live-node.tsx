import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

/** The activity gutter participates in layout, including for one-line nodes. */
export function ReviewLiveNode({
  id,
  revision,
  children,
}: {
  id: string;
  revision: string;
  children?: ReactNode;
}) {
  const content = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  useLayoutEffect(() => {
    setActive(true);
    const element = content.current;
    const reduced = element?.ownerDocument.defaultView?.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const animation = reduced
      ? undefined
      : element?.animate?.([{ opacity: 0.35 }, { opacity: 1 }], {
          duration: 320,
          easing: "ease-out",
        });
    const timer = setTimeout(() => setActive(false), 1400);
    return () => {
      clearTimeout(timer);
      animation?.cancel();
    };
  }, [revision]);
  return (
    <section
      id={id}
      className="review-live-node"
      data-authoring={active || undefined}
    >
      <span className="review-live-node__activity" aria-hidden="true">
        {Array.from({ length: 9 }, (_, index) => (
          <i key={index} />
        ))}
      </span>
      <div ref={content} className="review-live-node__content">
        {children}
      </div>
    </section>
  );
}
