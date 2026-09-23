import { z } from "zod";

export const WHITEBOARD_INTERACTION_EVENT = "whiteboard-interaction";

const WhiteboardInteractionDetailSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inline-hover"), path: z.string() }),
  z.object({ kind: z.literal("inline-navigation"), path: z.string() }),
]);

export type WhiteboardInteractionDetail = z.infer<
  typeof WhiteboardInteractionDetailSchema
>;

export function emitWhiteboardInteraction(
  target: HTMLElement | null,
  detail: WhiteboardInteractionDetail,
): void {
  target?.dispatchEvent(
    new CustomEvent<WhiteboardInteractionDetail>(WHITEBOARD_INTERACTION_EVENT, {
      bubbles: true,
      detail,
    }),
  );
}

export function whiteboardInteractionDetail(
  event: Event,
): WhiteboardInteractionDetail | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail = WhiteboardInteractionDetailSchema.safeParse(event.detail);

  return detail.success ? detail.data : null;
}
