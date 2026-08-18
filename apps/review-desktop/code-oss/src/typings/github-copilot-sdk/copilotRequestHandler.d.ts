import type { LlmInferenceHeaders } from "./generated/rpc.js";
declare const kSuppressCloseOnDispose: unique symbol;
/**
 * Per-request context handed to every {@link CopilotRequestHandler} hook.
 *
 * @experimental
 */
export interface CopilotRequestContext {
    readonly requestId: string;
    readonly sessionId?: string;
    readonly transport: "http" | "websocket";
    url: string;
    headers: LlmInferenceHeaders;
    readonly signal: AbortSignal;
}
/**
 * Terminal status for a callback-owned WebSocket connection.
 *
 * @experimental
 */
export declare class CopilotWebSocketCloseStatus {
    readonly description?: string | undefined;
    readonly errorCode?: string | undefined;
    readonly error?: Error | undefined;
    static readonly normalClosure: CopilotWebSocketCloseStatus;
    constructor(description?: string | undefined, errorCode?: string | undefined, error?: Error | undefined);
}
/**
 * Lower-level WebSocket handler with no upstream connection.
 *
 * This is the abstract base shared by all WebSocket handlers. It does not open
 * or forward to any upstream server on its own — subclass it directly only when
 * you want to service a fully synthetic connection yourself (e.g. answer the
 * runtime without any real backend). For the common case of mutating and
 * forwarding traffic to the real upstream, subclass {@link CopilotWebSocketForwarder}
 * instead, which connects upstream and forwards by default.
 *
 * @experimental
 */
export declare abstract class CopilotWebSocketHandler implements AsyncDisposable {
    #private;
    [kSuppressCloseOnDispose]: boolean;
    protected readonly context: CopilotRequestContext;
    protected constructor(context: CopilotRequestContext);
    sendResponseMessage(data: string | Uint8Array): Promise<void>;
    close(status?: CopilotWebSocketCloseStatus): Promise<void>;
    abstract sendRequestMessage(data: string | Uint8Array): Promise<void> | void;
    [Symbol.asyncDispose](): Promise<void>;
}
/**
 * WebSocket handler that connects to the real upstream and forwards traffic by
 * default. This is the type returned by the default
 * {@link CopilotRequestHandler.openWebSocket}.
 *
 * Override nothing to get full pass-through. To mutate traffic, subclass this
 * type and override a message hook, then call `super` to keep forwarding to the
 * upstream. (Subclassing {@link CopilotWebSocketHandler} instead would drop
 * forwarding entirely.)
 *
 * @experimental
 */
export declare class CopilotWebSocketForwarder extends CopilotWebSocketHandler {
    #private;
    constructor(context: CopilotRequestContext);
    sendRequestMessage(data: string | Uint8Array): void;
    close(status?: CopilotWebSocketCloseStatus): Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
}
/**
 * Base class for SDK consumers who want to observe or mutate the outbound
 * model-layer requests the runtime issues (for both CAPI and BYOK providers).
 * Subclass and override {@link sendRequest} or {@link openWebSocket}; an
 * instance that overrides nothing is a transparent pass-through.
 *
 * @experimental
 */
export declare class CopilotRequestHandler {
    #private;
    protected sendRequest(request: Request, ctx: CopilotRequestContext): Promise<Response>;
    protected openWebSocket(ctx: CopilotRequestContext): Promise<CopilotWebSocketHandler>;
}
export {};
