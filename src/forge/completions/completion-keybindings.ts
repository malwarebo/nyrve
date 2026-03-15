/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../vs/nls.js';
import { Action2, registerAction2 } from '../../vs/platform/actions/common/actions.js';
import { KeybindingWeight } from '../../vs/platform/keybinding/common/keybindingsRegistry.js';
import { KeyCode, KeyMod } from '../../vs/base/common/keyCodes.js';
import { ContextKeyExpr, RawContextKey } from '../../vs/platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../vs/platform/instantiation/common/instantiation.js';
import { IForgeGhostTextRenderer } from './ghost-text-renderer.js';
import { IForgeCompletionEngine } from './completion-engine.js';

// --- Context Keys ---

export const ForgeCompletionVisibleContext = new RawContextKey<boolean>('forgeCompletionVisible', false, localize('forgeCompletionVisible', "Whether a Forge inline completion is currently visible"));

// --- Category ---

const FORGE_COMPLETIONS_CATEGORY = localize2('forge.completions.category', "Forge Completions");

// --- Actions ---

/** Tab: Accept the full inline completion. */
registerAction2(class AcceptCompletionAction extends Action2 {
	constructor() {
		super({
			id: 'forge.completions.accept',
			title: localize2('forge.completions.accept', "Accept Completion"),
			category: FORGE_COMPLETIONS_CATEGORY,
			keybinding: {
				primary: KeyCode.Tab,
				weight: KeybindingWeight.EditorContrib + 100,
				when: ContextKeyExpr.has('forgeCompletionVisible'),
			},
			precondition: ContextKeyExpr.has('forgeCompletionVisible'),
		});
	}

	run(accessor: ServicesAccessor): void {
		const ghostText = accessor.get(IForgeGhostTextRenderer);
		ghostText.accept();
	}
});

/** Escape: Dismiss the inline completion. */
registerAction2(class DismissCompletionAction extends Action2 {
	constructor() {
		super({
			id: 'forge.completions.dismiss',
			title: localize2('forge.completions.dismiss', "Dismiss Completion"),
			category: FORGE_COMPLETIONS_CATEGORY,
			keybinding: {
				primary: KeyCode.Escape,
				weight: KeybindingWeight.EditorContrib + 100,
				when: ContextKeyExpr.has('forgeCompletionVisible'),
			},
			precondition: ContextKeyExpr.has('forgeCompletionVisible'),
		});
	}

	run(accessor: ServicesAccessor): void {
		const ghostText = accessor.get(IForgeGhostTextRenderer);
		ghostText.dismiss();
	}
});

/** Cmd+Right / Ctrl+Right: Accept one word of the completion. */
registerAction2(class AcceptWordAction extends Action2 {
	constructor() {
		super({
			id: 'forge.completions.acceptWord',
			title: localize2('forge.completions.acceptWord', "Accept Completion Word"),
			category: FORGE_COMPLETIONS_CATEGORY,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.RightArrow,
				weight: KeybindingWeight.EditorContrib + 100,
				when: ContextKeyExpr.has('forgeCompletionVisible'),
			},
			precondition: ContextKeyExpr.has('forgeCompletionVisible'),
		});
	}

	run(accessor: ServicesAccessor): void {
		const ghostText = accessor.get(IForgeGhostTextRenderer);
		ghostText.acceptWord();
	}
});

/** Cmd+Down / Ctrl+Down: Accept one line of the completion. */
registerAction2(class AcceptLineAction extends Action2 {
	constructor() {
		super({
			id: 'forge.completions.acceptLine',
			title: localize2('forge.completions.acceptLine', "Accept Completion Line"),
			category: FORGE_COMPLETIONS_CATEGORY,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.DownArrow,
				weight: KeybindingWeight.EditorContrib + 100,
				when: ContextKeyExpr.has('forgeCompletionVisible'),
			},
			precondition: ContextKeyExpr.has('forgeCompletionVisible'),
		});
	}

	run(accessor: ServicesAccessor): void {
		const ghostText = accessor.get(IForgeGhostTextRenderer);
		ghostText.acceptLine();
	}
});

/** Alt+]: Next completion suggestion. */
registerAction2(class NextCompletionAction extends Action2 {
	constructor() {
		super({
			id: 'forge.completions.next',
			title: localize2('forge.completions.next', "Next Completion"),
			category: FORGE_COMPLETIONS_CATEGORY,
			keybinding: {
				primary: KeyMod.Alt | KeyCode.BracketRight,
				weight: KeybindingWeight.EditorContrib + 100,
				when: ContextKeyExpr.has('forgeCompletionVisible'),
			},
			precondition: ContextKeyExpr.has('forgeCompletionVisible'),
		});
	}

	run(accessor: ServicesAccessor): void {
		const ghostText = accessor.get(IForgeGhostTextRenderer);
		ghostText.next();
	}
});

/** Alt+[: Previous completion suggestion. */
registerAction2(class PreviousCompletionAction extends Action2 {
	constructor() {
		super({
			id: 'forge.completions.previous',
			title: localize2('forge.completions.previous', "Previous Completion"),
			category: FORGE_COMPLETIONS_CATEGORY,
			keybinding: {
				primary: KeyMod.Alt | KeyCode.BracketLeft,
				weight: KeybindingWeight.EditorContrib + 100,
				when: ContextKeyExpr.has('forgeCompletionVisible'),
			},
			precondition: ContextKeyExpr.has('forgeCompletionVisible'),
		});
	}

	run(accessor: ServicesAccessor): void {
		const ghostText = accessor.get(IForgeGhostTextRenderer);
		ghostText.previous();
	}
});

/** Cmd+Shift+Space / Ctrl+Shift+Space: Explicitly trigger a completion. */
registerAction2(class TriggerCompletionAction extends Action2 {
	constructor() {
		super({
			id: 'forge.completions.trigger',
			title: localize2('forge.completions.trigger', "Trigger Inline Completion"),
			category: FORGE_COMPLETIONS_CATEGORY,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Space,
				weight: KeybindingWeight.EditorContrib + 100,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const engine = accessor.get(IForgeCompletionEngine);
		await engine.complete('explicit');
	}
});
