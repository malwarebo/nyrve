/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../vs/base/common/lifecycle.js';
import { BackgroundSuggestion } from '../../agent/background-agent.js';

/**
 * Renders a suggestion tooltip popup with title, description, and action buttons.
 * Created on-demand when the user clicks a gutter indicator.
 */
export class NyrveSuggestionTooltip extends Disposable {

	private readonly _disposables = this._register(new DisposableStore());
	private readonly _element: HTMLElement;

	constructor(
		parent: HTMLElement,
		private readonly suggestion: BackgroundSuggestion,
		private readonly onApply: (suggestion: BackgroundSuggestion) => void,
		private readonly onDismiss: (suggestion: BackgroundSuggestion) => void,
		private readonly onExplain: (suggestion: BackgroundSuggestion) => void,
	) {
		super();

		this._element = document.createElement('div');
		this._element.className = `nyrve-suggestion-tooltip nyrve-suggestion-severity-${suggestion.severity}`;
		parent.appendChild(this._element);

		this._render();
	}

	private _render(): void {
		this._element.textContent = '';

		// Header
		const header = document.createElement('div');
		header.className = 'nyrve-suggestion-tooltip-header';

		const severity = document.createElement('span');
		severity.className = `nyrve-suggestion-severity-badge`;
		severity.textContent = this.suggestion.severity.toUpperCase();
		header.appendChild(severity);

		const title = document.createElement('span');
		title.className = 'nyrve-suggestion-tooltip-title';
		title.textContent = this.suggestion.title;
		header.appendChild(title);

		this._element.appendChild(header);

		// Description
		const desc = document.createElement('div');
		desc.className = 'nyrve-suggestion-tooltip-body';
		desc.textContent = this.suggestion.description;
		this._element.appendChild(desc);

		// Fix preview
		if (this.suggestion.suggestedFix) {
			const fix = document.createElement('div');
			fix.className = 'nyrve-suggestion-tooltip-fix';
			fix.textContent = this.suggestion.suggestedFix.description;
			this._element.appendChild(fix);
		}

		// Actions
		const actions = document.createElement('div');
		actions.className = 'nyrve-suggestion-tooltip-actions';

		if (this.suggestion.suggestedFix) {
			actions.appendChild(this._createButton('Apply Fix', 'nyrve-btn-primary', () => this.onApply(this.suggestion)));
		}

		actions.appendChild(this._createButton('Explain', 'nyrve-btn-secondary', () => this.onExplain(this.suggestion)));
		actions.appendChild(this._createButton('Dismiss', 'nyrve-btn-dismiss', () => this.onDismiss(this.suggestion)));

		this._element.appendChild(actions);
	}

	private _createButton(label: string, className: string, onClick: () => void): HTMLButtonElement {
		const btn = document.createElement('button');
		btn.className = className;
		btn.textContent = label;
		const listener = () => onClick();
		btn.addEventListener('click', listener);
		this._disposables.add({ dispose: () => btn.removeEventListener('click', listener) });
		return btn;
	}

	hide(): void {
		this._element.remove();
	}
}
