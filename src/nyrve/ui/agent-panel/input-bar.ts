/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, EventType } from '../../../vs/base/browser/dom.js';
import { createTrustedTypesPolicy } from '../../../vs/base/browser/trustedTypes.js';
import { Disposable } from '../../../vs/base/common/lifecycle.js';
import { Emitter, Event } from '../../../vs/base/common/event.js';
import { localize } from '../../../vs/nls.js';

const ttPolicy = createTrustedTypesPolicy('nyrveInputBar', { createHTML: value => value });

// --- Types ---

export interface InputBarStatus {
	readonly connected: boolean;
	readonly hasApiKey: boolean;
	readonly tokensToday: number;
	readonly avgConfidence: number | undefined;
}

export interface AttachmentInfo {
	readonly id: string;
	readonly filename: string;
	readonly width: number;
	readonly height: number;
	readonly sizeKb: number;
	readonly thumbnailDataUrl: string;
}

// --- Send Arrow SVG (solid filled) ---

const SEND_ARROW_SVG = '<svg viewBox="0 0 24 24" fill="#1e1d1a" width="16" height="16"><path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94l18.04-8.25a.75.75 0 000-1.39L3.478 2.405z"/></svg>';
const STOP_SVG = '<svg viewBox="0 0 24 24" fill="#1e1d1a" width="14" height="14"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

// --- Inline SVG Icons ---

const PAPERCLIP_SVG = '<svg viewBox="0 0 24 24" fill="none" width="14" height="14"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CAMERA_SVG = '<svg viewBox="0 0 24 24" fill="none" width="14" height="14"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="13" r="4" stroke="currentColor" stroke-width="1.5"/></svg>';
const AT_SVG = '<svg viewBox="0 0 24 24" fill="none" width="14" height="14"><circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.5"/><path d="M16 8v5a3 3 0 006 0v-1a10 10 0 10-3.92 7.94" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

// --- Input Bar Component ---

export class NyrveInputBar extends Disposable {

	private readonly _onDidSubmit = this._register(new Emitter<string>());
	readonly onDidSubmit: Event<string> = this._onDidSubmit.event;

	private readonly _onDidCancel = this._register(new Emitter<void>());
	readonly onDidCancel: Event<void> = this._onDidCancel.event;

	private readonly _onDidClickAttach = this._register(new Emitter<void>());
	readonly onDidClickAttach: Event<void> = this._onDidClickAttach.event;

	private readonly _onDidClickScreenshot = this._register(new Emitter<void>());
	readonly onDidClickScreenshot: Event<void> = this._onDidClickScreenshot.event;

	private readonly _onDidClickMention = this._register(new Emitter<void>());
	readonly onDidClickMention: Event<void> = this._onDidClickMention.event;

	private readonly _onDidRemoveAttachment = this._register(new Emitter<string>());
	readonly onDidRemoveAttachment: Event<string> = this._onDidRemoveAttachment.event;

	private _element!: HTMLElement;
	private _textarea!: HTMLTextAreaElement;
	private _sendButton!: HTMLElement;
	private _statusLine!: HTMLElement;
	private _statusDot!: HTMLElement;
	private _statusText!: HTMLElement;
	private _tokensText!: HTMLElement;
	private _confidenceText!: HTMLElement;
	private _attachmentContainer!: HTMLElement;
	private _isGenerating = false;

	render(parent: HTMLElement): HTMLElement {
		this._element = $('div.nyrve-input-bar');
		this._element.style.cssText = 'flex-shrink: 0; padding: 8px 10px 10px; background: #1e1d1a;';

		// Status bar
		this._statusLine = $('div.nyrve-status-line');
		this._statusLine.style.cssText = 'display: flex; align-items: center; gap: 6px; font-size: 10px; color: #444441; padding: 0 2px; margin-bottom: 8px;';

		this._statusDot = $('span.nyrve-status-dot');
		this._statusDot.style.cssText = 'width: 5px; height: 5px; border-radius: 50%; background: #5DCAA5; flex-shrink: 0;';
		this._statusLine.appendChild(this._statusDot);

		this._statusText = $('span');
		this._statusText.textContent = localize('nyrve.input.connected', "Connected");
		this._statusLine.appendChild(this._statusText);

		const sep1 = $('span');
		sep1.textContent = '|';
		sep1.style.color = '#3a382f';
		this._statusLine.appendChild(sep1);

		this._tokensText = $('span');
		this._tokensText.textContent = '0 tokens today';
		this._statusLine.appendChild(this._tokensText);

		this._confidenceText = $('span');
		this._confidenceText.textContent = '\u2014';
		this._confidenceText.style.marginLeft = 'auto';
		this._statusLine.appendChild(this._confidenceText);

		this._element.appendChild(this._statusLine);

		// Attachment preview container (hidden by default)
		this._attachmentContainer = $('div.nyrve-attachment-preview');
		this._attachmentContainer.style.cssText = 'display: none; margin-bottom: 6px;';
		this._element.appendChild(this._attachmentContainer);

		// Input row: wrapper + send button
		const inputRow = $('div.nyrve-input-row');
		inputRow.style.cssText = 'display: flex; gap: 6px; align-items: center;';

		// Input wrapper (textarea + tool buttons)
		const inputWrapper = $('div.nyrve-input-wrapper');
		inputWrapper.style.cssText = 'flex: 1; display: flex; align-items: flex-end; background: #27261f; border: 1px solid #3a382f; border-radius: 10px; padding: 4px;';

		this._textarea = document.createElement('textarea');
		this._textarea.placeholder = localize('nyrve.input.placeholder', "Ask Nyrve anything...");
		this._textarea.style.cssText = 'flex: 1; background: none; border: none; color: #e8e6de; font-size: 13px; font-family: inherit; padding: 6px 8px; min-height: 20px; max-height: 120px; resize: none; outline: none;';
		this._textarea.rows = 1;

		// Auto-resize
		this._register(addDisposableListener(this._textarea, EventType.INPUT, () => {
			this._textarea.style.height = 'auto';
			this._textarea.style.height = Math.min(this._textarea.scrollHeight, 120) + 'px';
			this._updateSendButtonState();
		}));

		// Enter to submit, Shift+Enter for newline
		this._register(addDisposableListener(this._textarea, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this._submit();
			}
		}));

		inputWrapper.appendChild(this._textarea);

		// Focus-within border effect
		this._register(addDisposableListener(this._textarea, EventType.FOCUS, () => {
			inputWrapper.style.borderColor = '#EF9F27';
		}));
		this._register(addDisposableListener(this._textarea, EventType.BLUR, () => {
			inputWrapper.style.borderColor = '#3a382f';
		}));

		// Tool buttons
		const toolButtons = $('div.nyrve-tool-buttons');
		toolButtons.style.cssText = 'display: flex; gap: 1px; align-items: center; padding-right: 2px;';

		toolButtons.appendChild(this._createToolButton(PAPERCLIP_SVG, localize('nyrve.input.attach', "Attach image"), () => this._onDidClickAttach.fire()));
		toolButtons.appendChild(this._createToolButton(CAMERA_SVG, localize('nyrve.input.screenshot', "Screenshot"), () => this._onDidClickScreenshot.fire()));
		toolButtons.appendChild(this._createToolButton(AT_SVG, localize('nyrve.input.mention', "@ mention"), () => this._onDidClickMention.fire()));

		inputWrapper.appendChild(toolButtons);
		inputRow.appendChild(inputWrapper);

		// Send button
		this._sendButton = $('button.nyrve-send-btn');
		this._sendButton.style.cssText = 'width: 32px; height: 32px; border-radius: 8px; background: #EF9F27; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; opacity: 0.4; transition: opacity 0.15s;';
		this._setTrustedHtml(this._sendButton, SEND_ARROW_SVG);

		this._register(addDisposableListener(this._sendButton, EventType.MOUSE_ENTER, () => {
			if (!this._isSendDisabled()) {
				this._sendButton.style.background = '#FAC775';
			}
		}));
		this._register(addDisposableListener(this._sendButton, EventType.MOUSE_LEAVE, () => {
			this._sendButton.style.background = '#EF9F27';
		}));
		this._register(addDisposableListener(this._sendButton, EventType.MOUSE_DOWN, () => {
			if (!this._isSendDisabled()) {
				this._sendButton.style.transform = 'scale(0.95)';
			}
		}));
		this._register(addDisposableListener(this._sendButton, EventType.MOUSE_UP, () => {
			this._sendButton.style.transform = '';
		}));
		this._register(addDisposableListener(this._sendButton, EventType.CLICK, () => {
			if (this._isGenerating) {
				this._onDidCancel.fire();
			} else {
				this._submit();
			}
		}));

		inputRow.appendChild(this._sendButton);
		this._element.appendChild(inputRow);

		parent.appendChild(this._element);
		return this._element;
	}

	focus(): void {
		this._textarea?.focus();
	}

	getValue(): string {
		return this._textarea?.value ?? '';
	}

	setValue(text: string): void {
		if (this._textarea) {
			this._textarea.value = text;
			this._textarea.style.height = 'auto';
			this._textarea.style.height = Math.min(this._textarea.scrollHeight, 120) + 'px';
			this._updateSendButtonState();
		}
	}

	appendValue(text: string): void {
		if (this._textarea) {
			this._textarea.value += text;
			this._textarea.style.height = 'auto';
			this._textarea.style.height = Math.min(this._textarea.scrollHeight, 120) + 'px';
			this._updateSendButtonState();
		}
	}

	setGenerating(generating: boolean): void {
		this._isGenerating = generating;
		if (generating) {
			this._setTrustedHtml(this._sendButton, STOP_SVG);
			this._sendButton.style.opacity = '1';
			this._sendButton.style.cursor = 'pointer';
		} else {
			this._setTrustedHtml(this._sendButton, SEND_ARROW_SVG);
			this._updateSendButtonState();
		}
	}

	updateStatus(status: InputBarStatus): void {
		if (status.hasApiKey && status.connected) {
			this._statusDot.style.background = '#5DCAA5';
			this._statusText.textContent = localize('nyrve.input.connected', "Connected");
		} else if (status.hasApiKey && !status.connected) {
			this._statusDot.style.background = '#E24B4A';
			this._statusText.textContent = localize('nyrve.input.disconnected', "Disconnected");
		} else {
			this._statusDot.style.background = '#EF9F27';
			this._statusText.textContent = localize('nyrve.input.noApiKey', "No API key");
		}

		this._tokensText.textContent = `${status.tokensToday.toLocaleString()} tokens today`;
		this._confidenceText.textContent = status.avgConfidence !== undefined
			? `${status.avgConfidence}% avg confidence`
			: '\u2014';
	}

	showAttachments(attachments: AttachmentInfo[]): void {
		this._attachmentContainer.replaceChildren();
		if (attachments.length === 0) {
			this._attachmentContainer.style.display = 'none';
			return;
		}

		this._attachmentContainer.style.cssText = 'display: flex; gap: 8px; overflow-x: auto; margin-bottom: 6px;';

		for (const att of attachments.slice(0, 5)) {
			const card = $('div.nyrve-att-card');
			card.style.cssText = 'display: flex; align-items: center; gap: 8px; background: #27261f; border: 1px solid #3a382f; border-radius: 8px; padding: 8px 10px; flex-shrink: 0;';

			const thumb = $('img') as HTMLImageElement;
			thumb.src = att.thumbnailDataUrl;
			thumb.alt = att.filename;
			thumb.style.cssText = 'width: 40px; height: 40px; border-radius: 6px; object-fit: cover;';
			card.appendChild(thumb);

			const info = $('div');
			info.style.cssText = 'display: flex; flex-direction: column;';

			const name = $('span');
			name.textContent = att.filename;
			name.style.cssText = 'font-size: 12px; color: #d3d1c7;';
			info.appendChild(name);

			const meta = $('span');
			meta.textContent = `${att.width}\u00d7${att.height} \u00b7 ${att.sizeKb} KB`;
			meta.style.cssText = 'font-size: 11px; color: #5F5E5A;';
			info.appendChild(meta);

			card.appendChild(info);

			const removeBtn = $('button.nyrve-att-remove');
			removeBtn.textContent = '\u2715';
			removeBtn.style.cssText = 'width: 16px; height: 16px; border-radius: 50%; background: transparent; border: none; cursor: pointer; font-size: 10px; color: #5F5E5A; margin-left: 4px;';
			removeBtn.title = localize('nyrve.input.removeAttachment', "Remove");

			this._register(addDisposableListener(removeBtn, EventType.MOUSE_ENTER, () => { removeBtn.style.background = '#3a382f'; }));
			this._register(addDisposableListener(removeBtn, EventType.MOUSE_LEAVE, () => { removeBtn.style.background = 'transparent'; }));
			this._register(addDisposableListener(removeBtn, EventType.CLICK, () => { this._onDidRemoveAttachment.fire(att.id); }));

			card.appendChild(removeBtn);
			this._attachmentContainer.appendChild(card);
		}
	}

	private _createToolButton(iconSvg: string, tooltip: string, onClick: () => void): HTMLElement {
		const btn = $('button.nyrve-tool-btn');
		btn.style.cssText = 'width: 26px; height: 26px; border-radius: 6px; background: transparent; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; color: #5F5E5A; outline: none;';
		this._setTrustedHtml(btn, iconSvg);
		btn.title = tooltip;

		this._register(addDisposableListener(btn, EventType.MOUSE_ENTER, () => { btn.style.background = '#3a382f'; btn.style.color = '#b4b2a9'; }));
		this._register(addDisposableListener(btn, EventType.MOUSE_LEAVE, () => { btn.style.background = 'transparent'; btn.style.color = '#5F5E5A'; }));
		this._register(addDisposableListener(btn, EventType.CLICK, onClick));

		return btn;
	}

	private _submit(): void {
		const value = this._textarea.value.trim();
		if (!value || this._isGenerating) {
			return;
		}
		this._onDidSubmit.fire(value);
		this._textarea.value = '';
		this._textarea.style.height = 'auto';
		this._updateSendButtonState();
	}

	private _isSendDisabled(): boolean {
		return !this._isGenerating && !this._textarea.value.trim();
	}

	private _updateSendButtonState(): void {
		if (this._isGenerating) {
			return;
		}
		const disabled = !this._textarea.value.trim();
		this._sendButton.style.opacity = disabled ? '0.4' : '1';
		this._sendButton.style.cursor = disabled ? 'default' : 'pointer';
	}

	private _setTrustedHtml(el: HTMLElement, html: string): void {
		el.innerHTML = (ttPolicy?.createHTML(html) ?? html) as unknown as string;
	}
}
