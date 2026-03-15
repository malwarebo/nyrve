/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// --- Features Section Types ---

export type BackgroundAgentMode = 'active' | 'on-save' | 'on-commit' | 'off';

export interface BackgroundModeOption {
	readonly value: BackgroundAgentMode;
	readonly label: string;
}

// --- Features Section Helpers ---

export const BACKGROUND_MODE_OPTIONS: readonly BackgroundModeOption[] = [
	{ value: 'active', label: 'Active \u2014 real-time' },
	{ value: 'on-save', label: 'On Save' },
	{ value: 'on-commit', label: 'On Commit' },
	{ value: 'off', label: 'Off' },
];

/** Settings keys for feature toggles. */
export const FEATURE_SETTINGS = {
	backgroundAgentEnabled: 'forge.backgroundAgent.enabled',
	backgroundAgentMode: 'forge.backgroundAgent.mode',
	indexerEnabled: 'forge.indexer.enabled',
	memoryEnabled: 'forge.memory.enabled',
	githubEnabled: 'forge.github.enabled',
	diffAutoOpen: 'forge.diff.autoOpenOnChange',
	diffShowGutter: 'forge.diff.showGutterDecorations',
} as const;

/** Default values for feature settings. */
export const FEATURE_DEFAULTS = {
	backgroundAgentEnabled: true,
	backgroundAgentMode: 'on-save' as BackgroundAgentMode,
	indexerEnabled: true,
	memoryEnabled: true,
	githubEnabled: true,
	diffAutoOpen: true,
	diffShowGutter: true,
} as const;
