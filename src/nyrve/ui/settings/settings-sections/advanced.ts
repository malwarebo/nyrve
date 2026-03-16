/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// --- Advanced Section Helpers ---

/** Settings keys for advanced configuration. */
export const ADVANCED_SETTINGS = {
	contextTokenBudget: 'nyrve.context.defaultTokenBudget',
	backgroundDailyBudget: 'nyrve.backgroundAgent.dailyTokenBudget',
	taskDailyBudget: 'nyrve.tasks.dailyTokenBudget',
	memoryMaxEntries: 'nyrve.memory.maxEntries',
	memoryDecayDays: 'nyrve.memory.decayDays',
} as const;

/** Default values for advanced settings. */
export const ADVANCED_DEFAULTS = {
	contextTokenBudget: 30000,
	backgroundDailyBudget: 500000,
	taskDailyBudget: 1000000,
	memoryMaxEntries: 1000,
	memoryDecayDays: 90,
} as const;

/** Validation bounds for advanced numeric settings. */
export const ADVANCED_BOUNDS = {
	contextTokenBudget: { min: 1000, max: 100000, step: 1000 },
	backgroundDailyBudget: { min: 0, max: Infinity, step: 10000 },
	taskDailyBudget: { min: 0, max: Infinity, step: 10000 },
	memoryMaxEntries: { min: 100, max: Infinity, step: 100 },
	memoryDecayDays: { min: 7, max: Infinity, step: 1 },
} as const;
