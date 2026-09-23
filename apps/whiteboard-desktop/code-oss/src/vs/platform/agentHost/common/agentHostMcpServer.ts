/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { McpServerState, McpServerStatus } from './state/protocol/state.js';

/** A controllable MCP server exposed by an agent host. */
export interface IAgentHostMcpServer {
	readonly id: string;
	readonly name: string;
	readonly enabled: boolean;
	readonly status: McpServerStatus;
	readonly state: McpServerState;
	readonly logOutputChannelId?: string;
	start(): Promise<void>;
	stop(): Promise<void>;
	setEnabled(enabled: boolean): void;
}
