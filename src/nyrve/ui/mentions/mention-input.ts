/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../vs/base/common/lifecycle.js';
import { Emitter } from '../../../vs/base/common/event.js';
import { INyrveMentionRegistry, MentionDefinition } from '../../context/mention-registry.js';

/**
 * An autocomplete dropdown for @-mentions in the agent chat input.
 * Triggers on '@' keypress, shows fuzzy-filtered mention options,
 * supports keyboard navigation and selection.
 */
export class NyrveMentionInput extends Disposable {

	private readonly _disposables = this._register(new DisposableStore());
	private readonly _onDidSelectMention = this._register(new Emitter<MentionDefinition>());
	readonly onDidSelectMention = this._onDidSelectMention.event;

	private readonly _dropdown: HTMLElement;
	private _visible = false;
	private _matches: readonly MentionDefinition[] = [];
	private _selectedIndex = 0;

	constructor(
		parent: HTMLElement,
		private readonly mentionRegistry: INyrveMentionRegistry,
	) {
		super();

		this._dropdown = document.createElement('div');
		this._dropdown.className = 'nyrve-mention-dropdown';
		this._dropdown.style.display = 'none';
		parent.appendChild(this._dropdown);
	}

	/** Call on every keypress in the chat input. Returns true if the dropdown handled the event. */
	handleKeyDown(e: KeyboardEvent): boolean {
		if (!this._visible) {
			return false;
		}

		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				this._selectedIndex = Math.min(this._selectedIndex + 1, this._matches.length - 1);
				this._renderItems();
				return true;
			case 'ArrowUp':
				e.preventDefault();
				this._selectedIndex = Math.max(this._selectedIndex - 1, 0);
				this._renderItems();
				return true;
			case 'Enter':
			case 'Tab':
				e.preventDefault();
				if (this._matches.length > 0) {
					this._onDidSelectMention.fire(this._matches[this._selectedIndex]);
				}
				this.hide();
				return true;
			case 'Escape':
				e.preventDefault();
				this.hide();
				return true;
			default:
				return false;
		}
	}

	/** Show the dropdown, optionally with a query. */
	show(query: string = ''): void {
		this._selectedIndex = 0;
		this._matches = this.mentionRegistry.searchMentions(query);
		this._visible = true;
		this._dropdown.style.display = '';
		this._renderItems();
	}

	/** Update the query filter without toggling visibility. */
	updateQuery(query: string): void {
		this._selectedIndex = 0;
		this._matches = this.mentionRegistry.searchMentions(query);
		this._renderItems();

		if (this._matches.length === 0) {
			this.hide();
		}
	}

	/** Hide the dropdown. */
	hide(): void {
		this._visible = false;
		this._dropdown.style.display = 'none';
		this._dropdown.textContent = '';
	}

	get isVisible(): boolean {
		return this._visible;
	}

	private _renderItems(): void {
		this._disposables.clear();
		this._dropdown.textContent = '';

		for (let i = 0; i < this._matches.length; i++) {
			const mention = this._matches[i];
			const item = document.createElement('div');
			item.className = 'nyrve-mention-item';
			if (i === this._selectedIndex) {
				item.classList.add('nyrve-mention-item-selected');
			}

			const name = document.createElement('span');
			name.className = 'nyrve-mention-item-name';
			name.textContent = `@${mention.name}`;
			item.appendChild(name);

			const desc = document.createElement('span');
			desc.className = 'nyrve-mention-item-desc';
			desc.textContent = mention.description;
			item.appendChild(desc);

			if (mention.argumentHint) {
				const hint = document.createElement('span');
				hint.className = 'nyrve-mention-item-hint';
				hint.textContent = mention.argumentHint;
				item.appendChild(hint);
			}

			const idx = i;
			const clickHandler = () => {
				this._onDidSelectMention.fire(this._matches[idx]);
				this.hide();
			};
			item.addEventListener('click', clickHandler);
			this._disposables.add({ dispose: () => item.removeEventListener('click', clickHandler) });

			this._dropdown.appendChild(item);
		}
	}
}
