/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConnectionStatus } from '../../../core/auth-service.js';
import { TokenUsageSummary } from '../../../agent/token-tracker.js';

// --- Account Section Types ---

export interface AccountSectionState {
	readonly connectionStatus: ConnectionStatus;
	readonly hasApiKey: boolean;
	readonly todayUsage: TokenUsageSummary;
}

// --- Account Section Helpers ---

export function getConnectionBadgeClass(status: ConnectionStatus): string {
	switch (status) {
		case 'connected': return 'connection-connected';
		case 'disconnected': return 'connection-disconnected';
		case 'no-key': return 'connection-no-key';
		case 'connecting': return 'connection-no-key';
	}
}

export function getConnectionLabel(status: ConnectionStatus): string {
	switch (status) {
		case 'connected': return 'Connected';
		case 'disconnected': return 'Disconnected';
		case 'no-key': return 'No API Key';
		case 'connecting': return 'Connecting...';
	}
}

export function formatTokenCount(count: number): string {
	return count.toLocaleString();
}

export function formatCost(usd: number): string {
	return `$${usd.toFixed(2)}`;
}
