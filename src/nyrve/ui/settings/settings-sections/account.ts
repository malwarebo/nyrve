/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConnectionStatus } from '../../../core/auth-service.js';
import { TokenUsageSummary } from '../../../agent/token-tracker.js';

// --- Account Section Types ---

export type AuthMethod = 'api-key' | 'oauth';

export interface AccountSectionState {
	readonly connectionStatus: ConnectionStatus;
	readonly hasApiKey: boolean;
	readonly todayUsage: TokenUsageSummary;
	readonly authMethod: AuthMethod;
	readonly isOAuthSigningIn: boolean;
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

export function getConnectionLabel(status: ConnectionStatus, isOAuthSigningIn?: boolean): string {
	if (isOAuthSigningIn && status === 'connecting') {
		return 'Signing in...';
	}
	switch (status) {
		case 'connected': return 'Connected';
		case 'disconnected': return 'Disconnected';
		case 'no-key': return 'No API Key';
		case 'connecting': return 'Connecting...';
	}
}

export function getSignInButtonLabel(state: AccountSectionState): string {
	if (state.isOAuthSigningIn) {
		return 'Cancel Sign In';
	}
	if (state.hasApiKey) {
		return 'Sign Out';
	}
	return 'Sign in with Anthropic';
}

export function formatTokenCount(count: number): string {
	return count.toLocaleString();
}

export function formatCost(usd: number): string {
	return `$${usd.toFixed(2)}`;
}
