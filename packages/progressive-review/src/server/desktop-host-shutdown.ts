interface DesktopHostMessagePort {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  off(event: "message", listener: (event: { data: unknown }) => void): void;
}

interface DesktopHostProcess {
  parentPort?: DesktopHostMessagePort;
  on(event: "message", listener: (message: unknown) => void): void;
  off(event: "message", listener: (message: unknown) => void): void;
}

export function listenForDesktopHostShutdown(
  hostProcess: DesktopHostProcess,
  onShutdown: () => void,
  onTelemetrySetting?: (enabled: boolean) => void,
  onStageRustAnalyzer?: (path: string) => void,
): () => void {
  const handleMessage = (message: unknown) => {
    if (
      message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "shutdown"
    ) {
      onShutdown();
      return;
    }
    if (
      message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "telemetry-setting" &&
      typeof (message as { enabled?: unknown }).enabled === "boolean"
    ) {
      onTelemetrySetting?.((message as { enabled: boolean }).enabled);
      return;
    }
    if (
      message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "stage-rust-analyzer" &&
      typeof (message as { path?: unknown }).path === "string" &&
      (message as { path: string }).path.length > 0
    ) {
      onStageRustAnalyzer?.((message as { path: string }).path);
    }
  };

  if (hostProcess.parentPort) {
    const handleParentMessage = (event: { data: unknown }) => {
      handleMessage(event.data);
    };
    hostProcess.parentPort.on("message", handleParentMessage);
    return () => hostProcess.parentPort?.off("message", handleParentMessage);
  }

  hostProcess.on("message", handleMessage);
  return () => hostProcess.off("message", handleMessage);
}
