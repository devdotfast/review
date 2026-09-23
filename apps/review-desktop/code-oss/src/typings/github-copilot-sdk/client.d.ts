import { createServerRpc } from "./generated/rpc.js";
import { CopilotSession } from "./session.js";
import type { CopilotClientOptions, GetAuthStatusResponse, GetStatusResponse, ModelInfo, ResumeSessionConfig, SessionConfig, SessionLifecycleEventType, SessionLifecycleHandler, SessionListFilter, SessionMetadata, TypedSessionLifecycleHandler } from "./types.js";
export declare class CopilotClient {
    private cliStartTimeout;
    private cliProcess;
    private connection;
    private messageWriter;
    private socket;
    private runtimePort;
    private actualHost;
    private state;
    private sessions;
    private stderrBuffer;
    /** Resolved connection mode chosen in the constructor. */
    private connectionConfig;
    /** Resolved path to the runtime executable (only used for child-process kinds). */
    private resolvedCliPath;
    /** Resolved environment passed to the spawned runtime. */
    private resolvedEnv;
    private options;
    private isExternalServer;
    private forceStopping;
    /** Token sent in `connect`; auto-generated when the SDK spawns its own CLI in TCP mode. */
    private effectiveConnectionToken?;
    private onListModels?;
    private onGetTraceContext?;
    private modelsCache;
    private modelsCacheLock;
    private sessionLifecycleHandlers;
    private typedLifecycleHandlers;
    private _rpc;
    private _internalRpc;
    private processExitPromise;
    private negotiatedProtocolVersion;
    /** Connection-level session filesystem config, set via constructor option. */
    private sessionFsConfig;
    private requestHandler;
    private onGitHubTelemetry?;
    private clientGlobalHandlers;
    /**
     * Typed server-scoped RPC methods.
     * @throws Error if the client is not connected
     */
    get rpc(): ReturnType<typeof createServerRpc>;
    private logDebugTiming;
    private logDebug;
    /**
     * Creates a new CopilotClient instance.
     *
     * @param options - Configuration options for the client
     *
     * @example
     * ```typescript
     * // Default: spawns the bundled runtime over stdio
     * const client = new CopilotClient();
     *
     * // Connect to an existing runtime
     * const client = new CopilotClient({
     *   connection: RuntimeConnection.forUri("localhost:3000"),
     * });
     *
     * // Spawn the runtime over TCP on a chosen port
     * const client = new CopilotClient({
     *   connection: RuntimeConnection.forTcp({ port: 9001 }),
     * });
     *
     * // Use a custom runtime binary
     * const client = new CopilotClient({
     *   connection: RuntimeConnection.forStdio({ path: "/usr/local/bin/copilot" }),
     *   logLevel: "debug",
     * });
     * ```
     */
    constructor(options?: CopilotClientOptions);
    private connectionExtraArgs;
    /**
     * Parse CLI URL into host and port
     * Supports formats: "host:port", "http://host:port", "https://host:port", or just "port"
     */
    private parseCliUrl;
    private validateSessionFsConfig;
    private setupSessionFs;
    private setupClientGlobalHandlers;
    /**
     * Starts the CLI server and establishes a connection.
     *
     * If connecting to an external server (via cliUrl), only establishes the connection.
     * Otherwise, spawns the CLI server process and then connects.
     *
     * This method is called automatically the first time you create or resume a session.
     *
     * @returns A promise that resolves when the connection is established
     * @throws Error if the server fails to start or the connection fails
     *
     * @example
     * ```typescript
     * const client = new CopilotClient();
     * await client.start();
     * // Now ready to create sessions
     * ```
     */
    start(): Promise<void>;
    /**
     * Stops the CLI server and closes all active sessions.
     *
     * This method performs graceful cleanup:
     * 1. Closes all active sessions (releases in-memory resources)
     * 2. Requests runtime shutdown for SDK-owned CLI processes
     * 3. Closes the JSON-RPC connection
     * 4. Terminates the CLI server process (if spawned by this client)
     *
     * Note: session data on disk is preserved, so sessions can be resumed later.
     * To permanently remove session data before stopping, call
     * {@link deleteSession} for each session first.
     *
     * @returns A promise that resolves with an array of errors encountered during cleanup.
     *          An empty array indicates all cleanup succeeded.
     *
     * @example
     * ```typescript
     * const errors = await client.stop();
     * if (errors.length > 0) {
     *   console.error("Cleanup errors:", errors);
     * }
     * ```
     */
    stop(): Promise<Error[]>;
    /**
     * Alias for {@link stop} that lets `CopilotClient` participate in `await using`
     * blocks for automatic cleanup.
     *
     * @example
     * ```typescript
     * await using client = new CopilotClient();
     * const session = await client.createSession({ onPermissionRequest: approveAll });
     * await session.sendAndWait("Hello");
     * // client.stop() is called automatically when the block exits.
     * ```
     */
    [Symbol.asyncDispose](): Promise<void>;
    /**
     * Forcefully stops the CLI server without graceful cleanup.
     *
     * Use this when {@link stop} fails or takes too long. This method:
     * - Clears all sessions immediately without destroying them
     * - Force closes the connection
     * - Sends SIGKILL to the CLI process (if spawned by this client)
     *
     * @returns A promise that resolves when the force stop is complete
     *
     * @example
     * ```typescript
     * // If normal stop hangs, force stop
     * const stopPromise = client.stop();
     * const timeout = new Promise((_, reject) =>
     *   setTimeout(() => reject(new Error("Timeout")), 5000)
     * );
     *
     * try {
     *   await Promise.race([stopPromise, timeout]);
     * } catch {
     *   await client.forceStop();
     * }
     * ```
     */
    forceStop(): Promise<void>;
    /** Mode-specific defaults spread under the caller's config (app values win). */
    private configDefaultsForMode;
    /**
     * Returns the systemMessage config to use, adjusted for the current mode.
     * In empty mode we ensure the environment_context section is removed
     * unless the app has already taken control of it. `append` (and
     * unspecified) mode is promoted to `customize` so we can also strip
     * environment_context; the caller's `content` is preserved verbatim
     * because the runtime appends it as additional instructions in both
     * customize and append modes.
     */
    private getSystemMessageConfigForMode;
    /**
     * Mode-specific options applied via session.options.update after create/resume.
     *
     * In empty mode, defaults the four overridable feature flags to safe values
     * (caller values from `config` win). `installedPlugins=[]` is unconditional
     * in empty mode — apps that need custom plugins should switch modes.
     */
    private updateSessionOptionsForMode;
    createSession(config: SessionConfig): Promise<CopilotSession>;
    /**
     * Resumes an existing conversation session by its ID.
     *
     * This allows you to continue a previous conversation, maintaining all
     * conversation history. The session must have been previously created
     * and not deleted.
     *
     * @param sessionId - The ID of the session to resume
     * @param config - Optional configuration for the resumed session
     * @returns A promise that resolves with the resumed session
     * @throws Error if the session does not exist or the client is not connected
     *
     * @example
     * ```typescript
     * // Resume a previous session
     * const session = await client.resumeSession("session-123", { onPermissionRequest: approveAll });
     *
     * // Resume with new tools
     * const session = await client.resumeSession("session-123", {
     *   onPermissionRequest: approveAll,
     *   tools: [myNewTool]
     * });
     * ```
     */
    resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<CopilotSession>;
    /**
     * Sends a ping request to the server to verify connectivity.
     *
     * @param message - Optional message to include in the ping
     * @returns A promise that resolves with the ping response containing the message and timestamp
     * @throws Error if the client is not connected
     *
     * @example
     * ```typescript
     * const response = await client.ping("health check");
     * console.log(`Server responded at ${new Date(response.timestamp)}`);
     * ```
     */
    ping(message?: string): Promise<{
        message: string;
        timestamp: string;
        protocolVersion?: number;
    }>;
    /**
     * Get CLI status including version and protocol information
     */
    getStatus(): Promise<GetStatusResponse>;
    /**
     * Get current authentication status
     */
    getAuthStatus(): Promise<GetAuthStatusResponse>;
    /**
     * List available models with their metadata.
     *
     * If an `onListModels` handler was provided in the client options,
     * it is called instead of querying the CLI server.
     *
     * Results are cached after the first successful call to avoid rate limiting.
     * The cache is cleared when the client disconnects.
     *
     * @throws Error if not connected (when no custom handler is set)
     */
    listModels(): Promise<ModelInfo[]>;
    /**
     * Send the `connect` handshake (carrying the optional token) and verify the
     * server's protocol version. Falls back to `ping` against legacy servers
     * that don't implement `connect`.
     */
    private verifyProtocolVersion;
    /**
     * Gets the ID of the most recently updated session.
     *
     * This is useful for resuming the last conversation when the session ID
     * was not stored.
     *
     * @returns A promise that resolves with the session ID, or undefined if no sessions exist
     * @throws Error if the client is not connected
     *
     * @example
     * ```typescript
     * const lastId = await client.getLastSessionId();
     * if (lastId) {
     *   const session = await client.resumeSession(lastId, { onPermissionRequest: approveAll });
     * }
     * ```
     */
    getLastSessionId(): Promise<string | undefined>;
    /**
     * Permanently deletes a session and all its data from disk, including
     * conversation history, planning state, and artifacts.
     *
     * Unlike {@link CopilotSession.disconnect}, which only releases in-memory
     * resources and preserves session data for later resumption, this method
     * is irreversible. The session cannot be resumed after deletion.
     *
     * @param sessionId - The ID of the session to delete
     * @returns A promise that resolves when the session is deleted
     * @throws Error if the session does not exist or deletion fails
     *
     * @example
     * ```typescript
     * await client.deleteSession("session-123");
     * ```
     */
    deleteSession(sessionId: string): Promise<void>;
    /**
     * List all available sessions.
     *
     * @param filter - Optional filter to limit returned sessions by context fields
     *
     * @example
     * // List all sessions
     * const sessions = await client.listSessions();
     *
     * @example
     * // List sessions for a specific repository
     * const sessions = await client.listSessions({ repository: "owner/repo" });
     */
    listSessions(filter?: SessionListFilter): Promise<SessionMetadata[]>;
    /**
     * Gets metadata for a specific session by ID.
     *
     * This provides an efficient O(1) lookup of a single session's metadata
     * instead of listing all sessions. Returns undefined if the session is not found.
     *
     * @param sessionId - The ID of the session to look up
     * @returns A promise that resolves with the session metadata, or undefined if not found
     * @throws Error if the client is not connected
     *
     * @example
     * ```typescript
     * const metadata = await client.getSessionMetadata("session-123");
     * if (metadata) {
     *   console.log(`Session started at: ${metadata.startTime}`);
     * }
     * ```
     */
    getSessionMetadata(sessionId: string): Promise<SessionMetadata | undefined>;
    private static toSessionMetadata;
    /**
     * Gets the foreground session ID in TUI+server mode.
     *
     * This returns the ID of the session currently displayed in the TUI.
     * Only available when connecting to a server running in TUI+server mode (--ui-server).
     *
     * @returns A promise that resolves with the foreground session ID, or undefined if none
     * @throws Error if the client is not connected
     *
     * @example
     * ```typescript
     * const sessionId = await client.getForegroundSessionId();
     * if (sessionId) {
     *   console.log(`TUI is displaying session: ${sessionId}`);
     * }
     * ```
     */
    getForegroundSessionId(): Promise<string | undefined>;
    /**
     * Sets the foreground session in TUI+server mode.
     *
     * This requests the TUI to switch to displaying the specified session.
     * Only available when connecting to a server running in TUI+server mode (--ui-server).
     *
     * @param sessionId - The ID of the session to display in the TUI
     * @returns A promise that resolves when the session is switched
     * @throws Error if the client is not connected or if the operation fails
     *
     * @example
     * ```typescript
     * // Switch the TUI to display a specific session
     * await client.setForegroundSessionId("session-123");
     * ```
     */
    setForegroundSessionId(sessionId: string): Promise<void>;
    /**
     * Subscribes to a specific session lifecycle event type.
     *
     * Lifecycle events are emitted when sessions are created, deleted, updated,
     * or change foreground/background state (in TUI+server mode).
     *
     * @param eventType - The specific event type to listen for
     * @param handler - A callback function that receives events of the specified type
     * @returns A function that, when called, unsubscribes the handler
     *
     * @example
     * ```typescript
     * // Listen for when a session becomes foreground in TUI
     * const unsubscribe = client.onLifecycle("session.foreground", (event) => {
     *   console.log(`Session ${event.sessionId} is now displayed in TUI`);
     * });
     *
     * // Later, to stop receiving events:
     * unsubscribe();
     * ```
     */
    onLifecycle<K extends SessionLifecycleEventType>(eventType: K, handler: TypedSessionLifecycleHandler<K>): () => void;
    /**
     * Subscribes to all session lifecycle events.
     *
     * @param handler - A callback function that receives all lifecycle events
     * @returns A function that, when called, unsubscribes the handler
     *
     * @example
     * ```typescript
     * const unsubscribe = client.onLifecycle((event) => {
     *   switch (event.type) {
     *     case "session.foreground":
     *       console.log(`Session ${event.sessionId} is now in foreground`);
     *       break;
     *     case "session.created":
     *       console.log(`New session created: ${event.sessionId}`);
     *       break;
     *   }
     * });
     *
     * // Later, to stop receiving events:
     * unsubscribe();
     * ```
     */
    onLifecycle(handler: SessionLifecycleHandler): () => void;
    /**
     * Start the CLI server process
     */
    private startCLIServer;
    /**
     * Connect to the CLI server (via socket or stdio)
     */
    private connectToServer;
    /**
     * Connect to child via stdio pipes
     */
    private connectToChildProcessViaStdio;
    /**
     * Connect to parent via stdio pipes
     */
    private connectToParentProcessViaStdio;
    /**
     * Connect to the CLI server via TCP socket
     */
    private connectViaTcp;
    private attachConnectionHandlers;
    private handleSessionEventNotification;
    private handleSessionLifecycleNotification;
    private handleUserInputRequest;
    private handleExitPlanModeRequest;
    private handleAutoModeSwitchRequest;
    private handleHooksInvoke;
    private handleSystemMessageTransform;
}
