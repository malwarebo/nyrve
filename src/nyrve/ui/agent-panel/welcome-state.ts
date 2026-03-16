/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, EventType } from '../../../vs/base/browser/dom.js';
import { createTrustedTypesPolicy } from '../../../vs/base/browser/trustedTypes.js';
import { Disposable } from '../../../vs/base/common/lifecycle.js';
import { Emitter, Event } from '../../../vs/base/common/event.js';
import { localize } from '../../../vs/nls.js';

const ttPolicy = createTrustedTypesPolicy('nyrveWelcomeState', { createHTML: value => value });

// --- Types ---

export interface QuickAction {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly iconSvg: string;
	readonly inputTemplate: string;
}

export interface ProjectStatusItem {
	readonly label: string;
	readonly value: string;
	readonly dotColor: string;
}

// --- Constants ---

const QUICK_ACTIONS: QuickAction[] = [
	{
		id: 'plan',
		title: 'Plan a feature',
		description: 'Step-by-step, verified',
		iconSvg: '<svg viewBox="0 0 24 24" fill="none" width="18" height="18"><rect x="3" y="3" width="14" height="18" rx="2" stroke="#EF9F27" stroke-width="1.5"/><path d="M8 10l2 2 4-4" stroke="#EF9F27" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
		inputTemplate: 'Create a plan for ',
	},
	{
		id: 'fix',
		title: 'Fix errors',
		description: 'Read and resolve diagnostics',
		iconSvg: '<svg viewBox="0 0 24 24" fill="none" width="18" height="18"><circle cx="12" cy="12" r="9" stroke="#E24B4A" stroke-width="1.5"/><path d="M12 8v4M12 16h.01" stroke="#E24B4A" stroke-width="1.5" stroke-linecap="round"/></svg>',
		inputTemplate: 'Fix the errors in @errors ',
	},
	{
		id: 'test',
		title: 'Write tests',
		description: 'For the active file',
		iconSvg: '<svg viewBox="0 0 24 24" fill="none" width="18" height="18"><rect x="3" y="3" width="18" height="18" rx="2" stroke="#5DCAA5" stroke-width="1.5"/><path d="M8 12l3 3 5-5" stroke="#5DCAA5" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
		inputTemplate: 'Write tests for @active ',
	},
	{
		id: 'refactor',
		title: 'Refactor',
		description: 'Improve code structure',
		iconSvg: '<svg viewBox="0 0 24 24" fill="none" width="18" height="18"><path d="M17 1l4 4-4 4" stroke="#7F77DD" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 11V9a4 4 0 014-4h14M7 23l-4-4 4-4" stroke="#7F77DD" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 13v2a4 4 0 01-4 4H3" stroke="#7F77DD" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
		inputTemplate: 'Refactor @selection ',
	},
];

const CONTEXT_CHIPS = ['@active', '@errors', '@git-diff', '@tests', '@terminal', '@search'];

// Flame SVG without background rect — just the flame paths
const FLAME_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="44" height="44"><defs><linearGradient id="wf-outer" x1="0.3" y1="1" x2="0.7" y2="0"><stop offset="0%" stop-color="#993C1D"/><stop offset="40%" stop-color="#D85A30"/><stop offset="70%" stop-color="#EF9F27"/><stop offset="100%" stop-color="#FAC775"/></linearGradient><linearGradient id="wf-inner" x1="0.5" y1="1" x2="0.5" y2="0"><stop offset="0%" stop-color="#EF9F27"/><stop offset="60%" stop-color="#FAC775"/><stop offset="100%" stop-color="#FAEEDA"/></linearGradient></defs><path d="M256 56 C362 140, 432 244, 432 320 C432 416, 352 480, 256 480 C160 480, 80 416, 80 320 C80 244, 150 140, 256 56Z" fill="url(#wf-outer)"/><path d="M256 186 C309 250, 346 300, 346 344 C346 394, 306 420, 256 420 C206 420, 166 394, 166 344 C166 300, 203 250, 256 186Z" fill="url(#wf-inner)" opacity="0.85"/><ellipse cx="256" cy="356" rx="42" ry="46" fill="#FAEEDA" opacity="0.4"/></svg>';

// --- Welcome State Component ---

export class NyrveWelcomeState extends Disposable {

	private readonly _onDidClickQuickAction = this._register(new Emitter<string>());
	readonly onDidClickQuickAction: Event<string> = this._onDidClickQuickAction.event;

	private readonly _onDidClickContextChip = this._register(new Emitter<string>());
	readonly onDidClickContextChip: Event<string> = this._onDidClickContextChip.event;

	private _element!: HTMLElement;
	private _statusItems: { label: HTMLElement; value: HTMLElement; dot: HTMLElement }[] = [];

	render(parent: HTMLElement): HTMLElement {
		this._element = $('div.nyrve-welcome-state');
		this._element.style.cssText = 'display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; padding: 24px 16px; overflow-y: auto; gap: 0;';

		// Flame icon
		const flameContainer = $('div.nyrve-welcome-flame');
		flameContainer.style.cssText = 'margin-bottom: 16px;';
		flameContainer.innerHTML = (ttPolicy?.createHTML(FLAME_SVG) ?? FLAME_SVG) as unknown as string;
		this._element.appendChild(flameContainer);

		// Title
		const title = $('div.nyrve-welcome-title');
		title.textContent = localize('nyrve.welcome.title', "What are you working on?");
		title.style.cssText = 'font-size: 17px; font-weight: 500; color: #e8e6de; text-align: center; margin-bottom: 8px;';
		this._element.appendChild(title);

		// Subtitle
		const subtitle = $('div.nyrve-welcome-subtitle');
		subtitle.textContent = localize('nyrve.welcome.subtitle', "Nyrve sees your files, terminal, and git. Every change is verified before you see it.");
		subtitle.style.cssText = 'font-size: 12px; font-weight: 400; color: #888780; text-align: center; line-height: 1.6; max-width: 300px; margin-bottom: 20px;';
		this._element.appendChild(subtitle);

		// Quick action cards — 2x2 grid
		const grid = $('div.nyrve-welcome-grid');
		grid.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 8px; width: 100%; max-width: 340px;';

		for (const action of QUICK_ACTIONS) {
			grid.appendChild(this._createActionCard(action));
		}
		this._element.appendChild(grid);

		// Divider
		const divider = $('div.nyrve-welcome-divider');
		divider.style.cssText = 'width: 100%; max-width: 340px; height: 1px; background: #2e2d28; margin: 16px 0;';
		this._element.appendChild(divider);

		// Project status section
		this._element.appendChild(this._createProjectStatusSection());

		// Context mentions section
		this._element.appendChild(this._createContextMentionsSection());

		parent.appendChild(this._element);
		return this._element;
	}

	updateProjectStatus(items: ProjectStatusItem[]): void {
		for (let i = 0; i < items.length && i < this._statusItems.length; i++) {
			this._statusItems[i].dot.style.background = items[i].dotColor;
			this._statusItems[i].label.textContent = items[i].label;
			this._statusItems[i].value.textContent = items[i].value;
		}
	}

	show(): void {
		this._element.style.display = 'flex';
	}

	hide(): void {
		this._element.style.display = 'none';
	}

	private _createActionCard(action: QuickAction): HTMLElement {
		const card = $('div.nyrve-action-card');
		card.style.cssText = 'background: #27261f; border: 1px solid #3a382f; border-radius: 10px; padding: 12px; cursor: pointer;';

		const iconRow = $('div');
		iconRow.style.cssText = 'margin-bottom: 8px;';
		iconRow.innerHTML = (ttPolicy?.createHTML(action.iconSvg) ?? action.iconSvg) as unknown as string;
		card.appendChild(iconRow);

		const titleEl = $('div.nyrve-action-title');
		titleEl.textContent = action.title;
		titleEl.style.cssText = 'font-size: 12px; font-weight: 500; color: #d3d1c7; margin-bottom: 2px;';
		card.appendChild(titleEl);

		const desc = $('div.nyrve-action-desc');
		desc.textContent = action.description;
		desc.style.cssText = 'font-size: 11px; color: #5F5E5A;';
		card.appendChild(desc);

		this._register(addDisposableListener(card, EventType.MOUSE_ENTER, () => {
			card.style.background = '#2e2d26';
			card.style.borderColor = '#4a483f';
		}));
		this._register(addDisposableListener(card, EventType.MOUSE_LEAVE, () => {
			card.style.background = '#27261f';
			card.style.borderColor = '#3a382f';
		}));
		this._register(addDisposableListener(card, EventType.CLICK, () => {
			this._onDidClickQuickAction.fire(action.inputTemplate);
		}));

		return card;
	}

	private _createProjectStatusSection(): HTMLElement {
		const section = $('div.nyrve-welcome-status');
		section.style.cssText = 'width: 100%; max-width: 340px;';

		const label = $('div.nyrve-section-label');
		label.textContent = localize('nyrve.welcome.projectStatus', "Project status");
		label.style.cssText = 'font-size: 11px; font-weight: 500; color: #5F5E5A; letter-spacing: 0.3px; margin-bottom: 8px;';
		section.appendChild(label);

		const defaultItems: ProjectStatusItem[] = [
			{ label: 'DNA', value: 'Not scanned', dotColor: '#5F5E5A' },
			{ label: 'Verification', value: 'Not detected', dotColor: '#5F5E5A' },
			{ label: 'Memory', value: 'No data yet', dotColor: '#5F5E5A' },
		];

		const list = $('div.nyrve-status-list');
		list.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';

		for (const item of defaultItems) {
			const card = $('div.nyrve-status-card');
			card.style.cssText = 'display: flex; align-items: center; gap: 8px; background: #27261f; border-radius: 6px; padding: 6px 10px;';

			const dot = $('span.nyrve-status-dot');
			dot.style.cssText = `width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; background: ${item.dotColor};`;
			card.appendChild(dot);

			const labelEl = $('span.nyrve-status-label');
			labelEl.textContent = item.label;
			labelEl.style.cssText = 'font-size: 11px; color: #b4b2a9;';
			card.appendChild(labelEl);

			const valueEl = $('span.nyrve-status-value');
			valueEl.textContent = item.value;
			valueEl.style.cssText = 'font-size: 11px; color: #5F5E5A; margin-left: auto; white-space: nowrap;';
			card.appendChild(valueEl);

			this._statusItems.push({ label: labelEl, value: valueEl, dot });
			list.appendChild(card);
		}

		section.appendChild(list);
		return section;
	}

	private _createContextMentionsSection(): HTMLElement {
		const section = $('div.nyrve-welcome-mentions');
		section.style.cssText = 'width: 100%; max-width: 340px; margin-top: 16px;';

		const label = $('div.nyrve-section-label');
		label.textContent = localize('nyrve.welcome.contextMentions', "Context mentions");
		label.style.cssText = 'font-size: 11px; font-weight: 500; color: #5F5E5A; letter-spacing: 0.3px; margin-bottom: 8px;';
		section.appendChild(label);

		const row = $('div.nyrve-chips-row');
		row.style.cssText = 'display: flex; flex-wrap: wrap; gap: 5px;';

		for (const chip of CONTEXT_CHIPS) {
			const chipEl = $('button.nyrve-chip');
			chipEl.textContent = chip;
			chipEl.style.cssText = 'font-size: 11px; color: #5F5E5A; background: #27261f; border: 1px solid #3a382f; border-radius: 5px; padding: 3px 8px; cursor: pointer; outline: none;';

			this._register(addDisposableListener(chipEl, EventType.MOUSE_ENTER, () => {
				chipEl.style.borderColor = '#4a483f';
				chipEl.style.color = '#b4b2a9';
			}));
			this._register(addDisposableListener(chipEl, EventType.MOUSE_LEAVE, () => {
				chipEl.style.borderColor = '#3a382f';
				chipEl.style.color = '#5F5E5A';
			}));
			this._register(addDisposableListener(chipEl, EventType.CLICK, () => {
				this._onDidClickContextChip.fire(chip + ' ');
			}));

			row.appendChild(chipEl);
		}

		section.appendChild(row);
		return section;
	}
}
