/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../vs/base/common/lifecycle.js';
import { IForgeMemoryEngine, MemoryEntry, MemoryType, MemorySource } from '../../memory/memory-engine.js';

/**
 * Memory browser panel — displays all memories with search, filter,
 * edit, verify, and delete capabilities.
 */
export class ForgeMemoryBrowser extends Disposable {

	private readonly _itemDisposables = this._register(new DisposableStore());
	private readonly _container: HTMLElement;
	private _filterType: MemoryType | undefined;
	private _searchQuery = '';

	constructor(
		parent: HTMLElement,
		private readonly memoryEngine: IForgeMemoryEngine,
	) {
		super();

		this._container = document.createElement('div');
		this._container.className = 'forge-memory-browser';
		parent.appendChild(this._container);

		this._register(this.memoryEngine.onDidAddMemory(() => this._render()));
		this._register(this.memoryEngine.onDidUpdateMemory(() => this._render()));
		this._register(this.memoryEngine.onDidDeleteMemory(() => this._render()));

		this._render();
	}

	setFilter(type: MemoryType | undefined): void {
		this._filterType = type;
		this._render();
	}

	setSearch(query: string): void {
		this._searchQuery = query;
		this._render();
	}

	private _render(): void {
		this._itemDisposables.clear();
		this._container.textContent = '';

		// Toolbar
		this._container.appendChild(this._renderToolbar());

		// Memory list
		let memories = this._getFilteredMemories();

		if (memories.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'forge-memory-empty';
			empty.textContent = this._searchQuery ? 'No memories match your search' : 'No memories stored yet';
			this._container.appendChild(empty);
			return;
		}

		// Stats bar
		this._container.appendChild(this._renderStats(memories));

		// Items
		const list = document.createElement('div');
		list.className = 'forge-memory-list';
		for (const entry of memories) {
			list.appendChild(this._renderEntry(entry));
		}
		this._container.appendChild(list);
	}

	private _renderToolbar(): HTMLElement {
		const toolbar = document.createElement('div');
		toolbar.className = 'forge-memory-toolbar';

		// Search input
		const searchInput = document.createElement('input');
		searchInput.className = 'forge-memory-search';
		searchInput.type = 'text';
		searchInput.placeholder = 'Search memories...';
		searchInput.value = this._searchQuery;
		searchInput.addEventListener('input', () => {
			this._searchQuery = searchInput.value;
			this._render();
		});
		toolbar.appendChild(searchInput);

		// Type filter
		const filter = document.createElement('select');
		filter.className = 'forge-memory-filter';
		const allOption = document.createElement('option');
		allOption.value = '';
		allOption.textContent = 'All types';
		filter.appendChild(allOption);

		for (const type of Object.values(MemoryType)) {
			const opt = document.createElement('option');
			opt.value = type;
			opt.textContent = this._formatType(type);
			if (this._filterType === type) {
				opt.selected = true;
			}
			filter.appendChild(opt);
		}

		filter.addEventListener('change', () => {
			this._filterType = filter.value ? filter.value as MemoryType : undefined;
			this._render();
		});
		toolbar.appendChild(filter);

		return toolbar;
	}

	private _renderStats(memories: readonly MemoryEntry[]): HTMLElement {
		const stats = document.createElement('div');
		stats.className = 'forge-memory-stats';
		const verified = memories.filter(m => m.userVerified).length;
		const avgConf = memories.reduce((sum, m) => sum + m.confidence, 0) / memories.length;
		stats.textContent = `${memories.length} memories | ${verified} verified | Avg confidence: ${(avgConf * 100).toFixed(0)}%`;
		return stats;
	}

	private _renderEntry(entry: MemoryEntry): HTMLElement {
		const row = document.createElement('div');
		row.className = 'forge-memory-entry';

		// Type badge
		const badge = document.createElement('span');
		badge.className = 'forge-memory-type-badge';
		badge.textContent = this._formatType(entry.type);
		row.appendChild(badge);

		// Content
		const content = document.createElement('div');
		content.className = 'forge-memory-content';
		content.textContent = entry.content.length > 200 ? entry.content.slice(0, 200) + '...' : entry.content;
		row.appendChild(content);

		// Metadata row
		const meta = document.createElement('div');
		meta.className = 'forge-memory-meta';
		meta.textContent = [
			`Source: ${this._formatSource(entry.source)}`,
			`Confidence: ${(entry.confidence * 100).toFixed(0)}%`,
			`Accessed: ${entry.accessCount}x`,
			entry.userVerified ? 'Verified' : '',
			entry.tags.length > 0 ? `Tags: ${entry.tags.join(', ')}` : '',
		].filter(Boolean).join(' | ');
		row.appendChild(meta);

		// Actions
		const actions = document.createElement('div');
		actions.className = 'forge-memory-actions';

		if (!entry.userVerified) {
			actions.appendChild(this._actionBtn('Verify', () => {
				this.memoryEngine.updateMemory(entry.id, { userVerified: true, confidence: 1.0 });
			}));
		}

		actions.appendChild(this._actionBtn('Delete', () => {
			this.memoryEngine.deleteMemory(entry.id);
		}));

		row.appendChild(actions);
		return row;
	}

	private _actionBtn(label: string, onClick: () => void): HTMLButtonElement {
		const btn = document.createElement('button');
		btn.className = 'forge-memory-action-btn';
		btn.textContent = label;
		btn.addEventListener('click', onClick);
		return btn;
	}

	private _getFilteredMemories(): readonly MemoryEntry[] {
		let memories = this.memoryEngine.getAllMemories();

		if (this._filterType) {
			memories = memories.filter(m => m.type === this._filterType);
		}

		if (this._searchQuery) {
			const q = this._searchQuery.toLowerCase();
			memories = memories.filter(m =>
				m.content.toLowerCase().includes(q) ||
				m.tags.some(t => t.toLowerCase().includes(q))
			);
		}

		return memories;
	}

	private _formatType(type: MemoryType): string {
		return type.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
	}

	private _formatSource(source: MemorySource): string {
		return source.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
	}
}
