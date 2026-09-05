export function repairCommand(reviewUuid: string): string {
  return `review repair --review ${reviewUuid}`;
}

export function repairInstruction(
  reviewUuid: string,
  mapStale: boolean,
): string {
  const base = `This review's published artifacts could not be loaded. Run ${repairCommand(reviewUuid)} to regenerate them; repair keeps the review status, pinned commits, and threads.`;
  return mapStale
    ? `${base} The published software map also needs repair.`
    : base;
}
