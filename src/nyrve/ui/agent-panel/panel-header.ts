/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, EventType } from '../../../vs/base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../vs/base/common/lifecycle.js';
import { Emitter, Event } from '../../../vs/base/common/event.js';
import { localize } from '../../../vs/nls.js';
import { NyrveModelId } from '../../core/config.js';

// --- Types ---

export type PanelMode = 'agent' | 'plan' | 'taskqueue';

export interface PanelHeaderOptions {
	readonly currentMode: PanelMode;
	readonly currentModel: string;
	readonly availableModels: NyrveModelId[];
	readonly taskQueueCount: number;
}

const MODE_LABELS: Record<PanelMode, string> = {
	agent: 'Agent',
	plan: 'Plan',
	taskqueue: 'Task queue',
};

const MODE_META: Record<PanelMode, string> = {
	agent: 'Chat + actions',
	plan: 'Step-by-step',
	taskqueue: '0 pending',
};

const MODEL_DISPLAY: Record<string, { full: string; short: string; meta: string }> = {
	'claude-opus': { full: 'Claude Opus', short: 'Opus', meta: 'Complex' },
	'claude-sonnet': { full: 'Claude Sonnet', short: 'Sonnet', meta: 'Balanced' },
	'claude-haiku': { full: 'Claude Haiku', short: 'Haiku', meta: 'Fast' },
};

// --- Panel Header Component ---

export class NyrvePanelHeader extends Disposable {

	private readonly _onDidChangeMode = this._register(new Emitter<PanelMode>());
	readonly onDidChangeMode: Event<PanelMode> = this._onDidChangeMode.event;

	private readonly _onDidChangeModel = this._register(new Emitter<NyrveModelId>());
	readonly onDidChangeModel: Event<NyrveModelId> = this._onDidChangeModel.event;

	private readonly _onDidClickMemory = this._register(new Emitter<void>());
	readonly onDidClickMemory: Event<void> = this._onDidClickMemory.event;

	private readonly _onDidClickSettings = this._register(new Emitter<void>());
	readonly onDidClickSettings: Event<void> = this._onDidClickSettings.event;

	private readonly _onDidClickClose = this._register(new Emitter<void>());
	readonly onDidClickClose: Event<void> = this._onDidClickClose.event;

	private _element!: HTMLElement;
	private _modeButton!: HTMLElement;
	private _modelButton!: HTMLElement;
	private _modeDropdown: HTMLElement | undefined;
	private _modelDropdown: HTMLElement | undefined;
	private _currentMode: PanelMode;
	private _currentModel: NyrveModelId;
	private _availableModels: NyrveModelId[];
	private _taskQueueCount: number;
	private readonly _globalListeners = this._register(new DisposableStore());

	constructor(options: PanelHeaderOptions) {
		super();
		this._currentMode = options.currentMode;
		this._currentModel = options.currentModel as NyrveModelId;
		this._availableModels = [...options.availableModels];
		this._taskQueueCount = options.taskQueueCount;
	}

	render(parent: HTMLElement): HTMLElement {
		this._element = $('div.nyrve-panel-header');
		this._element.style.cssText = 'display: flex; align-items: center; padding: 6px 10px; gap: 8px; border-bottom: 1px solid #3a382f; background: #1e1d1a; flex-shrink: 0;';

		// Left: mode dropdown + Nyrve label
		const leftGroup = $('div.nyrve-header-left');
		leftGroup.style.cssText = 'display: flex; align-items: center; gap: 8px; flex: 1;';

		this._modeButton = this._createDropdownButton(MODE_LABELS[this._currentMode], true);
		this._modeButton.addEventListener('click', () => this._toggleModeDropdown());
		leftGroup.appendChild(this._modeButton);

		const nyrveLabel = $('span.nyrve-label');
		nyrveLabel.textContent = 'Nyrve';
		nyrveLabel.style.cssText = 'font-size: 13px; font-weight: 600; color: #d3d1c7;';
		leftGroup.appendChild(nyrveLabel);

		this._element.appendChild(leftGroup);

		// Right: model dropdown + icon buttons
		const rightGroup = $('div.nyrve-header-right');
		rightGroup.style.cssText = 'display: flex; align-items: center; gap: 4px;';

		const modelShort = MODEL_DISPLAY[this._currentModel]?.short ?? this._currentModel;
		this._modelButton = this._createDropdownButton(modelShort, false);
		this._modelButton.style.cssText += 'padding: 4px 8px; font-size: 11px;';
		this._modelButton.addEventListener('click', () => this._toggleModelDropdown());
		rightGroup.appendChild(this._modelButton);

		// Memory icon
		rightGroup.appendChild(this._createIconButton('\u{1F9E0}', localize('nyrve.header.memory', "Memory Browser"), () => this._onDidClickMemory.fire()));
		// Settings icon
		rightGroup.appendChild(this._createIconButton('\u2699', localize('nyrve.header.settings', "Settings"), () => this._onDidClickSettings.fire()));
		// Close icon
		rightGroup.appendChild(this._createIconButton('\u2715', localize('nyrve.header.close', "Close"), () => this._onDidClickClose.fire()));

		this._element.appendChild(rightGroup);
		parent.appendChild(this._element);

		// Close dropdowns on click outside
		this._globalListeners.add(addDisposableListener(document, EventType.CLICK, (e) => {
			if (!this._element.contains(e.target as Node)) {
				this._closeAllDropdowns();
			}
		}));

		return this._element;
	}

	updateTaskQueueCount(count: number): void {
		this._taskQueueCount = count;
	}

	updateModel(model: NyrveModelId): void {
		this._currentModel = model;
		const modelShort = MODEL_DISPLAY[model]?.short ?? model;
		const label = this._modelButton.querySelector('.nyrve-dropdown-label');
		if (label) {
			label.textContent = modelShort;
		}
	}

	private _createDropdownButton(label: string, withIcon: boolean): HTMLElement {
		const btn = $('button.nyrve-dropdown-btn');
		btn.style.cssText = 'display: flex; align-items: center; gap: 6px; background: #27261f; border: 1px solid #3a382f; border-radius: 6px; padding: 5px 10px; font-size: 12px; font-weight: 500; color: #d3d1c7; cursor: pointer; outline: none;';

		if (withIcon) {
			const icon = $('span.nyrve-mode-icon');
			icon.style.cssText = 'width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid #EF9F27;';
			btn.appendChild(icon);
		}

		const lbl = $('span.nyrve-dropdown-label');
		lbl.textContent = label;
		btn.appendChild(lbl);

		const chevron = $('span.nyrve-dropdown-chevron');
		chevron.textContent = '\u25BE';
		chevron.style.cssText = 'font-size: 10px; color: #6e6d68;';
		btn.appendChild(chevron);

		btn.addEventListener('mouseenter', () => {
			btn.style.background = '#2e2d26';
			btn.style.borderColor = '#4a483f';
		});
		btn.addEventListener('mouseleave', () => {
			btn.style.background = '#27261f';
			btn.style.borderColor = '#3a382f';
		});

		return btn;
	}

	private _createIconButton(icon: string, tooltip: string, onClick: () => void): HTMLElement {
		const btn = $('button.nyrve-icon-btn');
		btn.style.cssText = 'width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: transparent; border: none; cursor: pointer; font-size: 14px; color: #6e6d68; outline: none;';
		btn.textContent = icon;
		btn.title = tooltip;
		btn.addEventListener('click', onClick);
		btn.addEventListener('mouseenter', () => { btn.style.background = '#2e2d28'; btn.style.color = '#d3d1c7'; });
		btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; btn.style.color = '#6e6d68'; });
		return btn;
	}

	private _toggleModeDropdown(): void {
		if (this._modeDropdown) {
			this._closeAllDropdowns();
			return;
		}
		this._closeAllDropdowns();

		this._modeDropdown = $('div.nyrve-dropdown-menu');
		this._modeDropdown.style.cssText = 'position: absolute; top: 100%; left: 0; margin-top: 4px; background: #27261f; border: 1px solid #3a382f; border-radius: 8px; padding: 4px; min-width: 180px; z-index: 10;';

		const modes: PanelMode[] = ['agent', 'plan', 'taskqueue'];
		for (const mode of modes) {
			if (mode === 'taskqueue') {
				const sep = $('div.nyrve-dropdown-separator');
				sep.style.cssText = 'height: 1px; background: #3a382f; margin: 4px 0;';
				this._modeDropdown.appendChild(sep);
			}

			const item = $('div.nyrve-dropdown-item');
			item.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 5px; font-size: 12px; color: #b4b2a9; cursor: pointer;';

			const check = $('span');
			check.style.cssText = 'width: 12px; font-size: 12px;';
			check.textContent = mode === this._currentMode ? '\u2713' : '';
			if (mode === this._currentMode) {
				item.style.color = '#EF9F27';
				check.style.color = '#EF9F27';
			}
			item.appendChild(check);

			const label = $('span');
			label.textContent = MODE_LABELS[mode];
			label.style.flex = '1';
			item.appendChild(label);

			const meta = $('span');
			meta.style.cssText = 'font-size: 10px; color: #5F5E5A;';
			meta.textContent = mode === 'taskqueue' ? `${this._taskQueueCount} pending` : MODE_META[mode];
			item.appendChild(meta);

			item.addEventListener('mouseenter', () => { item.style.background = '#3a382f'; item.style.color = mode === this._currentMode ? '#EF9F27' : '#e8e6de'; });
			item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; item.style.color = mode === this._currentMode ? '#EF9F27' : '#b4b2a9'; });
			item.addEventListener('click', () => {
				this._currentMode = mode;
				const modeLabel = this._modeButton.querySelector('.nyrve-dropdown-label');
				if (modeLabel) {
					modeLabel.textContent = MODE_LABELS[mode];
				}
				this._closeAllDropdowns();
				this._onDidChangeMode.fire(mode);
			});
			this._modeDropdown.appendChild(item);
		}

		this._modeButton.style.position = 'relative';
		this._modeButton.appendChild(this._modeDropdown);
	}

	private _toggleModelDropdown(): void {
		if (this._modelDropdown) {
			this._closeAllDropdowns();
			return;
		}
		this._closeAllDropdowns();

		this._modelDropdown = $('div.nyrve-dropdown-menu');
		this._modelDropdown.style.cssText = 'position: absolute; top: 100%; right: 0; margin-top: 4px; background: #27261f; border: 1px solid #3a382f; border-radius: 8px; padding: 4px; min-width: 200px; z-index: 10;';

		for (const model of this._availableModels) {
			const display = MODEL_DISPLAY[model] ?? { full: model, short: model, meta: '' };
			const item = $('div.nyrve-dropdown-item');
			item.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 5px; font-size: 12px; color: #b4b2a9; cursor: pointer;';

			const check = $('span');
			check.style.cssText = 'width: 12px; font-size: 12px;';
			check.textContent = model === this._currentModel ? '\u2713' : '';
			if (model === this._currentModel) {
				item.style.color = '#EF9F27';
				check.style.color = '#EF9F27';
			}
			item.appendChild(check);

			const label = $('span');
			label.textContent = display.full;
			label.style.flex = '1';
			item.appendChild(label);

			const meta = $('span');
			meta.style.cssText = 'font-size: 10px; color: #5F5E5A;';
			meta.textContent = display.meta;
			item.appendChild(meta);

			item.addEventListener('mouseenter', () => { item.style.background = '#3a382f'; item.style.color = model === this._currentModel ? '#EF9F27' : '#e8e6de'; });
			item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; item.style.color = model === this._currentModel ? '#EF9F27' : '#b4b2a9'; });
			item.addEventListener('click', () => {
				this._currentModel = model;
				this.updateModel(model);
				this._closeAllDropdowns();
				this._onDidChangeModel.fire(model);
			});
			this._modelDropdown.appendChild(item);
		}

		this._modelButton.style.position = 'relative';
		this._modelButton.appendChild(this._modelDropdown);
	}

	private _closeAllDropdowns(): void {
		if (this._modeDropdown) {
			this._modeDropdown.remove();
			this._modeDropdown = undefined;
		}
		if (this._modelDropdown) {
			this._modelDropdown.remove();
			this._modelDropdown = undefined;
		}
	}
}
