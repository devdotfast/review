/**
 * The courier: the one character on the board. A marker-blue outline with
 * two dot eyes and two feet, the same figure at every size. Strokes take
 * `currentColor`; the shell is filled with the board so lines behind him
 * do not show through.
 */
export function CourierFigure({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 28 34"
      aria-hidden="true"
      focusable="false"
    >
      <path className="courier-whoosh" d="M-6 27h6M-9 31h5" />
      <path className="courier-leg courier-leg--left" d="M9 24v7h-4" />
      <path className="courier-leg courier-leg--right" d="M19 24v7h4" />
      <rect
        className="courier-shell"
        x="4"
        y="8"
        width="20"
        height="16"
        rx="6"
      />
      <g className="courier-eyes">
        <circle className="courier-eye" cx="11" cy="15" r="1.3" />
        <circle className="courier-eye" cx="18" cy="15" r="1.3" />
        <path
          className="courier-lids"
          d="M8.5 15.5q2.5-3 5 0M15.5 15.5q2.5-3 5 0"
        />
      </g>
    </svg>
  );
}
