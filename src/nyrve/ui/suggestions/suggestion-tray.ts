/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../vs/base/common/lifecycle.js';
import { INyrveBackgroundAgent, BackgroundSuggestion } from '../../agent/background-agent.js';

/**
 * A panel listing all active background agent suggestions across the workspace.
 * Rendered as a child component in the Nyrve panel area.
 */
export class NyrveSuggestionTray extends Disposable {

	private readonly _itemDisposables = this._register(new DisposableStore());
	private readonly _container: HTMLElement;

	constructor(
		parent: HTMLElement,
		private readonly backgroundAgent: INyrveBackgroundAgent,
	) {
		super();

		this._container = document.createElement('div');
		this._container.className = 'nyrve-suggestion-tray';
		parent.appendChild(this._container);

		this._register(this.backgroundAgent.onDidAddSuggestion(() => this._render()));
		this._register(this.backgroundAgent.onDidRemoveSuggestion(() => this._render()));

		this._render();
	}

	private _render(): void {
		this._itemDisposables.clear();
		this._container.textContent = '';

		const suggestions = this.backgroundAgent.getSuggestions();

		if (suggestions.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'nyrve-suggestion-tray-empty';
			empty.textContent = 'No active suggestions';
			this._container.appendChild(empty);
			return;
		}

		// Group by severity
		const critical = suggestions.filter(s => s.severity === 'critical');
		const warnings = suggestions.filter(s => s.severity === 'warning');
		const info = suggestions.filter(s => s.severity === 'info');

		if (critical.length > 0) {
			this._renderGroup('Critical', critical);
		}
		if (warnings.length > 0) {
			this._renderGroup('Warnings', warnings);
		}
		if (info.length > 0) {
			this._renderGroup('Info', info);
		}
	}

	private _renderGroup(label: string, suggestions: readonly BackgroundSuggestion[]): void {
		const group = document.createElement('div');
		group.className = 'nyrve-suggestion-tray-group';

		const header = document.createElement('div');
		header.className = 'nyrve-suggestion-tray-group-header';
		header.textContent = `${label} (${suggestions.length})`;
		group.appendChild(header);

		for (const suggestion of suggestions) {
			group.appendChild(this._renderItem(suggestion));
		}

		this._container.appendChild(group);
	}

	private _renderItem(suggestion: BackgroundSuggestion): HTMLElement {
		const item = document.createElement('div');
		item.className = `nyrve-suggestion-tray-item nyrve-severity-${suggestion.severity}`;

		const title = document.createElement('span');
		title.className = 'nyrve-suggestion-tray-title';
		title.textContent = suggestion.title;
		item.appendChild(title);

		const file = document.createElement('span');
		file.className = 'nyrve-suggestion-tray-file';
		const basename = suggestion.filePath.split('/').pop() ?? suggestion.filePath;
		file.textContent = `${basename}:${suggestion.lineRange.start}`;
		item.appendChild(file);

		const dismissBtn = document.createElement('button');
		dismissBtn.className = 'nyrve-suggestion-tray-dismiss';
		dismissBtn.textContent = 'Dismiss';
		dismissBtn.addEventListener('click', () => {
			this.backgroundAgent.dismissSuggestion(suggestion.id);
		});
		item.appendChild(dismissBtn);

		return item;
	}
}
