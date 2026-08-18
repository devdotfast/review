/**
 * Builder that produces a list of source-qualified tool filter strings for
 * {@link SessionConfigBase.availableTools}.
 *
 * Tools are classified by the runtime at registration time (not from name
 * parsing), so `addBuiltIn("foo")` matches only tools the runtime registered
 * as built-in, even if an MCP server or custom-agent extension happens to
 * register a tool with the same wire name.
 *
 * @example
 * ```typescript
 * const tools = new ToolSet()
 *     .addBuiltIn(BuiltInTools.Isolated)
 *     .addMcp("*")
 *     .addCustom("*");
 *
 * const session = await client.createSession({
 *     availableTools: tools,
 *     // ...
 * });
 * ```
 */
export declare class ToolSet {
    private readonly items;
    /**
     * Adds one or more built-in tool patterns.
     *
     * @param name A specific built-in tool name (e.g. `"bash"`) or `"*"` to match all
     *   built-in tools.
     */
    addBuiltIn(name: string): ToolSet;
    /**
     * Adds a list of built-in tool patterns (e.g. {@link BuiltInTools.Isolated}).
     */
    addBuiltIn(names: readonly string[]): ToolSet;
    /**
     * Adds a custom tool pattern. Matches tools registered via the SDK's
     * `tools` option or via custom agents.
     *
     * @param name A specific custom tool name or `"*"` to match all custom tools.
     */
    addCustom(name: string): ToolSet;
    /**
     * Adds an MCP tool pattern. Matches tools advertised by any configured
     * MCP server.
     *
     * @param toolName The runtime's canonical wire name for the MCP tool
     *   (e.g. `"github-list_issues"`), or `"*"` to match all MCP tools from
     *   any server.
     */
    addMcp(toolName: string): ToolSet;
    /**
     * Returns a defensive copy of the accumulated filter strings, suitable for
     * passing as {@link SessionConfigBase.availableTools}.
     */
    toArray(): string[];
}
/**
 * Curated sets of built-in tool names for common scenarios. Each constant is
 * meant to be passed to {@link ToolSet.addBuiltIn}.
 */
export declare const BuiltInTools: {
    /**
     * Built-in tools that operate only within the bounds of a single session —
     * no host filesystem access outside the session, no cross-session state,
     * no host environment access, no network. Safe to enable in `Mode = "empty"`
     * scenarios (e.g. multi-tenant servers) without leaking host capabilities.
     *
     * **Contract:** tools in this set MUST NOT be extended (even behind options
     * or args) to read or write state outside the session boundary. Adding
     * cross-session or host-state behavior to one of these tools is a
     * breaking change that requires removing it from this set.
     */
    readonly Isolated: readonly string[];
};
