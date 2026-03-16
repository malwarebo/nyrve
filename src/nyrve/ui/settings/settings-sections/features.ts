/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
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
	backgroundAgentEnabled: 'nyrve.backgroundAgent.enabled',
	backgroundAgentMode: 'nyrve.backgroundAgent.mode',
	indexerEnabled: 'nyrve.indexer.enabled',
	memoryEnabled: 'nyrve.memory.enabled',
	githubEnabled: 'nyrve.github.enabled',
	diffAutoOpen: 'nyrve.diff.autoOpenOnChange',
	diffShowGutter: 'nyrve.diff.showGutterDecorations',
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
