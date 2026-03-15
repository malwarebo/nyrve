/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// --- Models Section Types ---

export interface ModelOption {
	readonly value: string;
	readonly label: string;
}

// --- Models Section Helpers ---

/** Default model options shown in dropdowns. */
export const MODEL_OPTIONS: readonly ModelOption[] = [
	{ value: 'claude-opus', label: 'Claude Opus' },
	{ value: 'claude-sonnet', label: 'Claude Sonnet' },
	{ value: 'claude-haiku', label: 'Claude Haiku' },
];

/** Settings keys for model selection. */
export const MODEL_SETTINGS = {
	defaultModel: 'forge.agent.defaultModel',
	complexTaskModel: 'forge.agent.complexTaskModel',
	backgroundModel: 'forge.agent.backgroundModel',
	modelSwitcher: 'forge.agent.modelSwitcher',
} as const;

/** Default values for model settings. */
export const MODEL_DEFAULTS = {
	defaultModel: 'claude-sonnet',
	complexTaskModel: 'claude-opus',
	backgroundModel: 'claude-haiku',
	modelSwitcher: true,
} as const;
