/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// --- Privacy Section Helpers ---

/** Settings keys for privacy configuration. */
export const PRIVACY_SETTINGS = {
	telemetryEnabled: 'forge.telemetry.enabled',
	memoryCloudSync: 'forge.memory.cloudSync',
} as const;

/** Default values for privacy settings. All opt-in, default off. */
export const PRIVACY_DEFAULTS = {
	telemetryEnabled: false,
	memoryCloudSync: false,
} as const;
