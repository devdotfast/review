import { createSessionRpc } from "./generated/rpc.js";
import type { OpenCanvasInstance } from "./generated/rpc.js";
import type { MessageOptions, ContextTier, ReasoningEffort, ReasoningSummary, ModelCapabilitiesOverride, SessionCapabilities, SessionEvent, SessionEventHandler, SessionEventType, SessionUiApi, TypedSessionEventHandler } from "./types.js";
/** Assistant message event - the final response from the assistant. */
export type AssistantMessageEvent = Extract<SessionEvent, {
    type: "assistant.message";
}>;
/**
 * Represents a single conversation session with the Copilot CLI.
 *
 * A session maintains conversation state, handles events, and manages tool execution.
 * Sessions are created via {@link CopilotClient.createSession} or resumed via
 * {@link CopilotClient.resumeSession}.
 *
 * @example
 * ```typescript
 * const session = await client.createSession({ model: "gpt-4" });
 *
 * // Subscribe to events
 * session.on((event) => {
 *   if (event.type === "assistant.message") {
 *     console.log(event.data.content);
 *   }
 * });
 *
 * // Send a message and wait for completion
 * await session.sendAndWait({ prompt: "Hello, world!" });
 *
 * // Clean up
 * await session.disconnect();
 * ```
 */
export declare class CopilotSession {
    readonly sessionId: string;
    private connection;
    private _workspacePath?;
    private eventHandlers;
    private typedEventHandlers;
    private toolHandlers;
    private canvases;
    private bearerTokenProviders;
    private commandHandlers;
    private permissionHandler?;
    private mcpAuthHandler?;
    private userInputHandler?;
    private elicitationHandler?;
    private exitPlanModeHandler?;
    private autoModeSwitchHandler?;
    private hooks?;
    private transformCallbacks?;
    private _rpc;
    private traceContextProvider?;
    private _capabilities;
    private openCanvasInstances;
    private disconnected;
    /**
     * Typed session-scoped RPC methods.
     */
    get rpc(): ReturnType<typeof createSessionRpc>;
    /**
     * Path to the session workspace directory when infinite sessions are enabled.
     * Contains checkpoints/, plan.md, and files/ subdirectories.
     * Undefined if infinite sessions are disabled.
     */
    get workspacePath(): string | undefined;
    /**
     * Host capabilities reported when the session was created or resumed.
     * Use this to check feature support before calling capability-gated APIs.
     */
    get capabilities(): SessionCapabilities;
    /**
     * Interactive UI methods for showing dialogs to the user.
     * Only available when the CLI host supports elicitation
     * (`session.capabilities.ui?.elicitation === true`).
     *
     * @example
     * ```typescript
     * if (session.capabilities.ui?.elicitation) {
     *   const ok = await session.ui.confirm("Deploy to production?");
     * }
     * ```
     */
    get ui(): SessionUiApi;
    /**
     * Sends a message to this session and waits for the response.
     *
     * The message is processed asynchronously. Subscribe to events via {@link on}
     * to receive streaming responses and other session events.
     *
     * @param options - The message options including the prompt and optional attachments
     * @returns A promise that resolves with the message ID of the response
     * @throws Error if the session has been disconnected or the connection fails
     *
     * @example
     * ```typescript
     * const messageId = await session.send({
     *   prompt: "Explain this code",
     *   attachments: [{ type: "file", path: "./src/index.ts" }]
     * });
     * ```
     */
    send(prompt: string): Promise<string>;
    send(options: MessageOptions): Promise<string>;
    /**
     * Sends a message to this session and waits until the session becomes idle.
     *
     * This is a convenience method that combines {@link send} with waiting for
     * the `session.idle` event. Use this when you want to block until the
     * assistant has finished processing the message.
     *
     * Events are still delivered to handlers registered via {@link on} while waiting.
     *
     * @param options - The message options including the prompt and optional attachments
     * @param timeout - Timeout in milliseconds (default: 60000). Controls how long to wait; does not abort in-flight agent work.
     * @returns A promise that resolves with the final assistant message when the session becomes idle,
     *          or undefined if no assistant message was received
     * @throws Error if the timeout is reached before the session becomes idle
     * @throws Error if the session has been disconnected or the connection fails
     *
     * @example
     * ```typescript
     * // Send and wait for completion with default 60s timeout
     * const response = await session.sendAndWait({ prompt: "What is 2+2?" });
     * console.log(response?.data.content); // "4"
     * ```
     */
    sendAndWait(prompt: string, timeout?: number): Promise<AssistantMessageEvent | undefined>;
    sendAndWait(options: MessageOptions, timeout?: number): Promise<AssistantMessageEvent | undefined>;
    /**
     * Subscribes to events from this session.
     *
     * Events include assistant messages, tool executions, errors, and session state changes.
     * Multiple handlers can be registered and will all receive events.
     *
     * @param eventType - The specific event type to listen for (e.g., "assistant.message", "session.idle")
     * @param handler - A callback function that receives events of the specified type
     * @returns A function that, when called, unsubscribes the handler
     *
     * @example
     * ```typescript
     * // Listen for a specific event type
     * const unsubscribe = session.on("assistant.message", (event) => {
     *   console.log("Assistant:", event.data.content);
     * });
     *
     * // Later, to stop receiving events:
     * unsubscribe();
     * ```
     */
    on<K extends SessionEventType>(eventType: K, handler: TypedSessionEventHandler<K>): () => void;
    /**
     * Subscribes to all events from this session.
     *
     * @param handler - A callback function that receives all session events
     * @returns A function that, when called, unsubscribes the handler
     *
     * @example
     * ```typescript
     * const unsubscribe = session.on((event) => {
     *   switch (event.type) {
     *     case "assistant.message":
     *       console.log("Assistant:", event.data.content);
     *       break;
     *     case "session.error":
     *       console.error("Error:", event.data.message);
     *       break;
     *   }
     * });
     *
     * // Later, to stop receiving events:
     * unsubscribe();
     * ```
     */
    on(handler: SessionEventHandler): () => void;
    private upsertOpenCanvasFromEvent;
    private removeOpenCanvasFromEvent;
    private removeOpenCanvas;
    private upsertOpenCanvas;
    /**
     * Snapshot of canvas instances currently known to be open for this session.
     * Populated from the `session.resume` response and live `session.canvas.opened`
     * and `session.canvas.closed` events. Returns a defensive copy — mutating the
     * returned array has no effect on the session.
     */
    get openCanvases(): OpenCanvasInstance[];
    private assertElicitation;
    private _elicitation;
    private _confirm;
    private _select;
    private _input;
    /**
     * Retrieves all events and messages from this session's history.
     *
     * This returns the complete conversation history including user messages,
     * assistant responses, tool executions, and other session events.
     *
     * @returns A promise that resolves with an array of all session events
     * @throws Error if the session has been disconnected or the connection fails
     *
     * @example
     * ```typescript
     * const events = await session.getEvents();
     * for (const event of events) {
     *   if (event.type === "assistant.message") {
     *     console.log("Assistant:", event.data.content);
     *   }
     * }
     * ```
     */
    getEvents(): Promise<SessionEvent[]>;
    /**
     * Disconnects this session and releases all in-memory resources (event handlers,
     * tool handlers, permission handlers).
     *
     * Session state on disk (conversation history, planning state, artifacts) is
     * preserved, so the conversation can be resumed later by calling
     * {@link CopilotClient.resumeSession} with the session ID. To permanently
     * remove all session data including files on disk, use
     * {@link CopilotClient.deleteSession} instead.
     *
     * After calling this method, the session object can no longer be used.
     *
     * @returns A promise that resolves when the session is disconnected
     * @throws Error if the connection fails
     *
     * @example
     * ```typescript
     * // Clean up when done — session can still be resumed later
     * await session.disconnect();
     * ```
     */
    disconnect(): Promise<void>;
    /** Enables `await using session = ...` syntax for automatic cleanup. */
    [Symbol.asyncDispose](): Promise<void>;
    /**
     * Aborts the currently processing message in this session.
     *
     * Use this to cancel a long-running request. The session remains valid
     * and can continue to be used for new messages.
     *
     * @returns A promise that resolves when the abort request is acknowledged
     * @throws Error if the session has been disconnected or the connection fails
     *
     * @example
     * ```typescript
     * // Start a long-running request
     * const messagePromise = session.send({ prompt: "Write a very long story..." });
     *
     * // Abort after 5 seconds
     * setTimeout(async () => {
     *   await session.abort();
     * }, 5000);
     * ```
     */
    abort(): Promise<void>;
    /**
     * Change the model for this session.
     * The new model takes effect for the next message. Conversation history is preserved.
     *
     * @param model - Model ID to switch to
     * @param options - Optional settings for the new model
     *
     * @example
     * ```typescript
     * await session.setModel("gpt-4.1");
     * await session.setModel("claude-sonnet-4.6", { reasoningEffort: "high" });
     * ```
     */
    setModel(model: string, options?: {
        reasoningEffort?: ReasoningEffort;
        reasoningSummary?: ReasoningSummary;
        contextTier?: ContextTier;
        modelCapabilities?: ModelCapabilitiesOverride;
    }): Promise<void>;
    /**
     * Log a message to the session timeline.
     * The message appears in the session event stream and is visible to SDK consumers
     * and (for non-ephemeral messages) persisted to the session event log on disk.
     *
     * @param message - Human-readable message text
     * @param options - Optional log level and ephemeral flag
     *
     * @example
     * ```typescript
     * await session.log("Processing started");
     * await session.log("Disk usage high", { level: "warning" });
     * await session.log("Connection failed", { level: "error" });
     * await session.log("Debug info", { ephemeral: true });
     * ```
     */
    log(message: string, options?: {
        level?: "info" | "warning" | "error";
        ephemeral?: boolean;
    }): Promise<void>;
}
