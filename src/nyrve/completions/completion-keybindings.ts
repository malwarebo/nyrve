/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../vs/nls.js';
import { Action2, registerAction2 } from '../../vs/platform/actions/common/actions.js';
import { KeybindingWeight } from '../../vs/platform/keybinding/common/keybindingsRegistry.js';
import { KeyCode, KeyMod } from '../../vs/base/common/keyCodes.js';
import { ContextKeyExpr } from '../../vs/platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../vs/platform/instantiation/common/instantiation.js';
import { INyrveGhostTextRenderer } from './ghost-text-renderer.js';
import { INyrveCompletionEngine } from './completion-engine.js';

// --- Category ---

const NYRVE_COMPLETIONS_CATEGORY = localize2('nyrve.completions.category', "Nyrve Completions");

// --- Actions ---

/** Tab: Accept the full inline completion. */
registerAction2(class AcceptCompletionAction extends Action2 {
	constructor() {
		super({
			id: 'nyrve.completions.accept',
			title: localize2('nyrve.completions.accept', "Accept Completion"),
			category: NYRVE_COMPLETIONS_CATEGORY,
			keybinding: {
				primary: KeyCode.Tab,
				weight: KeybindingWeight.EditorContrib + 100,
				when: ContextKeyExpr.has('nyrveCompletionVisible'),
			},
			precondition: ContextKeyExpr.has('nyrveCompletionVisible'),
		});
	}

	run(accessor: ServicesAccessor): void {
		const ghostText = accessor.get(INyrveGhostTextRenderer);
		ghostText.accept();
	}
});

/** Escape: Dismiss the inline completion. */
registerAction2(class DismissCompletionAction extends Action2 {
	constructor() {
		super({
			id: 'nyrve.completions.dismiss',
			title: localize2('nyrve.completions.dismiss', "Dismiss Completion"),
			category: NYRVE_COMPLETIONS_CATEGORY,
			keybinding: {
				primary: KeyCode.Escape,
				weight: KeybindingWeight.EditorContrib + 100,
				when: ContextKeyExpr.has('nyrveCompletionVisible'),
			},
			precondition: ContextKeyExpr.has('nyrveCompletionVisible'),
		});
	}

	run(accessor: ServicesAccessor): void {
		const ghostText = accessor.get(INyrveGhostTextRenderer);
		ghostText.dismiss();
	}
});

/** Cmd+Right / Ctrl+Right: Accept one word of the completion. */
registerAction2(class AcceptWordAction extends Action2 {
	constructor() {
		super({
			id: 'nyrve.completions.acceptWord',
			title: localize2('nyrve.completions.acceptWord', "Accept Completion Word"),
			category: NYRVE_COMPLETIONS_CATEGORY,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.RightArrow,
				weight: KeybindingWeight.EditorContrib + 100,
				when: ContextKeyExpr.has('nyrveCompletionVisible'),
			},
			precondition: ContextKeyExpr.has('nyrveCompletionVisible'),
		});
	}

	run(accessor: ServicesAccessor): void {
		const ghostText = accessor.get(INyrveGhostTextRenderer);
		ghostText.acceptWord();
	}
});

/** Cmd+Down / Ctrl+Down: Accept one line of the completion. */
registerAction2(class AcceptLineAction extends Action2 {
	constructor() {
		super({
			id: 'nyrve.completions.acceptLine',
			title: localize2('nyrve.completions.acceptLine', "Accept Completion Line"),
			category: NYRVE_COMPLETIONS_CATEGORY,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.DownArrow,
				weight: KeybindingWeight.EditorContrib + 100,
				when: ContextKeyExpr.has('nyrveCompletionVisible'),
			},
			precondition: ContextKeyExpr.has('nyrveCompletionVisible'),
		});
	}

	run(accessor: ServicesAccessor): void {
		const ghostText = accessor.get(INyrveGhostTextRenderer);
		ghostText.acceptLine();
	}
});

/** Alt+]: Next completion suggestion. */
registerAction2(class NextCompletionAction extends Action2 {
	constructor() {
		super({
			id: 'nyrve.completions.next',
			title: localize2('nyrve.completions.next', "Next Completion"),
			category: NYRVE_COMPLETIONS_CATEGORY,
			keybinding: {
				primary: KeyMod.Alt | KeyCode.BracketRight,
				weight: KeybindingWeight.EditorContrib + 100,
				when: ContextKeyExpr.has('nyrveCompletionVisible'),
			},
			precondition: ContextKeyExpr.has('nyrveCompletionVisible'),
		});
	}

	run(accessor: ServicesAccessor): void {
		const ghostText = accessor.get(INyrveGhostTextRenderer);
		ghostText.next();
	}
});

/** Alt+[: Previous completion suggestion. */
registerAction2(class PreviousCompletionAction extends Action2 {
	constructor() {
		super({
			id: 'nyrve.completions.previous',
			title: localize2('nyrve.completions.previous', "Previous Completion"),
			category: NYRVE_COMPLETIONS_CATEGORY,
			keybinding: {
				primary: KeyMod.Alt | KeyCode.BracketLeft,
				weight: KeybindingWeight.EditorContrib + 100,
				when: ContextKeyExpr.has('nyrveCompletionVisible'),
			},
			precondition: ContextKeyExpr.has('nyrveCompletionVisible'),
		});
	}

	run(accessor: ServicesAccessor): void {
		const ghostText = accessor.get(INyrveGhostTextRenderer);
		ghostText.previous();
	}
});

/** Cmd+Shift+Space / Ctrl+Shift+Space: Explicitly trigger a completion. */
registerAction2(class TriggerCompletionAction extends Action2 {
	constructor() {
		super({
			id: 'nyrve.completions.trigger',
			title: localize2('nyrve.completions.trigger', "Trigger Inline Completion"),
			category: NYRVE_COMPLETIONS_CATEGORY,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Space,
				weight: KeybindingWeight.EditorContrib + 100,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const engine = accessor.get(INyrveCompletionEngine);
		await engine.complete('explicit');
	}
});
