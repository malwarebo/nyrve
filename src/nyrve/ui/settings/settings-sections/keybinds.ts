/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// --- Keybinds Section Types ---

export interface KeybindEntry {
	readonly action: string;
	readonly shortcut: string;
	readonly commandId: string;
}

// --- Keybinds Section Helpers ---

/** Nyrve keyboard shortcuts displayed in the settings page. */
export const NYRVE_KEYBINDS: readonly KeybindEntry[] = [
	{ action: 'Toggle Agent Panel', shortcut: 'Cmd+Shift+A', commandId: 'nyrve.toggleAgentPanel' },
	{ action: 'Accept Current Hunk', shortcut: 'Cmd+Shift+Y', commandId: 'nyrve.diff.acceptHunk' },
	{ action: 'Reject Current Hunk', shortcut: 'Cmd+Shift+N', commandId: 'nyrve.diff.rejectHunk' },
	{ action: 'Accept All Changes', shortcut: 'Cmd+Shift+Enter', commandId: 'nyrve.diff.acceptAll' },
];

/** Returns the platform-appropriate modifier key label. */
export function getPlatformModifier(): string {
	// In VS Code, platform detection happens via the environment
	// Default to Cmd for display; the actual keybinding uses KeyMod.CtrlCmd
	return 'Cmd';
}
