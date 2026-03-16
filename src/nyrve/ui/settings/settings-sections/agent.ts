/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// --- Agent Section Types ---

export type ConfirmationLevel = 'cautious' | 'balanced' | 'autonomous';

export interface ConfirmationOption {
	readonly value: ConfirmationLevel;
	readonly label: string;
}

// --- Agent Section Helpers ---

export const CONFIRMATION_OPTIONS: readonly ConfirmationOption[] = [
	{ value: 'cautious', label: 'Cautious \u2014 confirm every action' },
	{ value: 'balanced', label: 'Balanced \u2014 confirm writes and commands' },
	{ value: 'autonomous', label: 'Autonomous \u2014 no confirmation' },
];

/** Settings keys for agent configuration. */
export const AGENT_SETTINGS = {
	confirmationLevel: 'nyrve.agent.confirmationLevel',
	maxTokensPerRequest: 'nyrve.agent.maxTokensPerRequest',
	streamResponses: 'nyrve.agent.streamResponses',
} as const;

/** Default values for agent settings. */
export const AGENT_DEFAULTS = {
	confirmationLevel: 'balanced' as ConfirmationLevel,
	maxTokensPerRequest: 100000,
	streamResponses: true,
} as const;

/** Validation bounds for max tokens per request. */
export const MAX_TOKENS_BOUNDS = {
	min: 1000,
	max: 200000,
	step: 1000,
} as const;
