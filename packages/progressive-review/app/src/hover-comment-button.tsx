import type { CSSProperties, MouseEvent } from "react";

import { CommentIcon } from "./icons";

export function HoverCommentButton({
  onClick,
  className = "",
  style,
}: {
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      className={["comment-hover-button", className].filter(Boolean).join(" ")}
      style={style}
      onClick={onClick}
      aria-label="Comment"
      title="Comment"
    >
      <CommentIcon />
    </button>
  );
}
