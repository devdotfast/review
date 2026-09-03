export interface C4NodeMeasurementScheduler {
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(frame: number): void;
  setTimer(callback: () => void, delay: number): number;
  clearTimer(timer: number): void;
}

export function scheduleC4NodeMeasurements(
  measure: () => void,
  scheduler: C4NodeMeasurementScheduler = {
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (frame) => cancelAnimationFrame(frame),
    setTimer: (callback, delay) => window.setTimeout(callback, delay),
    clearTimer: (timer) => window.clearTimeout(timer),
  },
): () => void {
  let disposed = false;
  const run = () => {
    if (!disposed) measure();
  };

  // Native editor tabs can mount while Chromium reports the workbench page as
  // hidden. Animation frames are paused in that state, so take the initial
  // layout measurement synchronously and use frames only for refinement.
  run();
  const frame = scheduler.requestFrame(run);
  const followUpMeasurements = [120, 500].map((delay) =>
    scheduler.setTimer(run, delay),
  );

  return () => {
    disposed = true;
    scheduler.cancelFrame(frame);
    for (const timeout of followUpMeasurements) scheduler.clearTimer(timeout);
  };
}
