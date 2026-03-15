/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../vs/base/common/lifecycle.js';
import { Emitter } from '../../../vs/base/common/event.js';
import { MentionDefinition } from '../../context/mention-registry.js';

/**
 * A styled chip/pill element representing a resolved @-mention in the chat input.
 * Displays the mention type and argument, supports removal on click.
 */
export class ForgeMentionChip extends Disposable {

	private readonly _onDidRemove = this._register(new Emitter<ForgeMentionChip>());
	readonly onDidRemove = this._onDidRemove.event;

	private readonly _element: HTMLElement;

	constructor(
		parent: HTMLElement,
		readonly mention: MentionDefinition,
		readonly argument: string | undefined,
	) {
		super();

		this._element = document.createElement('span');
		this._element.className = `forge-mention-chip forge-mention-type-${mention.type}`;

		const label = document.createElement('span');
		label.className = 'forge-mention-chip-label';
		label.textContent = argument ? `@${mention.name} ${argument}` : `@${mention.name}`;
		this._element.appendChild(label);

		const removeBtn = document.createElement('span');
		removeBtn.className = 'forge-mention-chip-remove';
		removeBtn.textContent = '\u00d7'; // ×
		removeBtn.title = 'Remove';
		removeBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this._onDidRemove.fire(this);
		});
		this._element.appendChild(removeBtn);

		parent.appendChild(this._element);
	}

	/** Get the text representation for the message (e.g. @file "src/main.ts"). */
	toMentionText(): string {
		if (this.argument) {
			return `@${this.mention.name} "${this.argument}"`;
		}
		return `@${this.mention.name}`;
	}

	remove(): void {
		this._element.remove();
	}

	override dispose(): void {
		this.remove();
		super.dispose();
	}
}

/**
 * Manages a collection of mention chips inside a container element.
 */
export class ForgeMentionChipContainer extends Disposable {

	private readonly _chips: ForgeMentionChip[] = [];
	private readonly _container: HTMLElement;

	constructor(parent: HTMLElement) {
		super();

		this._container = document.createElement('div');
		this._container.className = 'forge-mention-chips';
		parent.appendChild(this._container);
	}

	addChip(mention: MentionDefinition, argument?: string): ForgeMentionChip {
		const chip = new ForgeMentionChip(this._container, mention, argument);
		this._chips.push(chip);

		this._register(chip.onDidRemove(c => {
			const idx = this._chips.indexOf(c);
			if (idx !== -1) {
				this._chips.splice(idx, 1);
			}
			c.dispose();
		}));

		return chip;
	}

	getChips(): readonly ForgeMentionChip[] {
		return this._chips;
	}

	/** Build the full mention text for all chips. */
	toMentionText(): string {
		return this._chips.map(c => c.toMentionText()).join(' ');
	}

	clear(): void {
		for (const chip of this._chips) {
			chip.dispose();
		}
		this._chips.length = 0;
	}
}
