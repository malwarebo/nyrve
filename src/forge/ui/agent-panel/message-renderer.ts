/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../vs/base/browser/dom.js';
import { createTrustedTypesPolicy } from '../../../vs/base/browser/trustedTypes.js';
import { Disposable } from '../../../vs/base/common/lifecycle.js';
import { Emitter, Event } from '../../../vs/base/common/event.js';
import { localize } from '../../../vs/nls.js';

const ttPolicy = createTrustedTypesPolicy('forgeMessageRenderer', { createHTML: value => value });

// --- Types ---

export interface VerificationSummary {
	readonly types: 'pass' | 'fail' | 'skip';
	readonly tests: { status: 'pass' | 'fail' | 'skip'; count?: number };
	readonly imports: 'pass' | 'fail' | 'skip';
	readonly coverage?: number;
}

// --- Message Renderer Component ---

export class ForgeMessageRenderer extends Disposable {

	private readonly _onDidClickVerification = this._register(new Emitter<void>());
	readonly onDidClickVerification: Event<void> = this._onDidClickVerification.event;

	private _container!: HTMLElement;
	private _thinkingElement: HTMLElement | undefined;

	render(parent: HTMLElement): HTMLElement {
		this._container = $('div.forge-messages');
		this._container.style.cssText = 'flex: 1; overflow-y: auto; padding: 8px 10px;';
		parent.appendChild(this._container);
		return this._container;
	}

	clear(): void {
		this._container.replaceChildren();
		this._thinkingElement = undefined;
	}

	get hasMessages(): boolean {
		return this._container.children.length > 0;
	}

	appendUserMessage(content: string, imageHtml?: string): void {
		this._removeThinking();
		const msg = $('div.forge-msg.forge-msg-user');
		msg.style.cssText = 'padding: 12px 0; border-bottom: 1px solid #2e2d28;';

		// Header row
		const header = $('div.forge-msg-header');
		header.style.cssText = 'display: flex; align-items: center; margin-bottom: 6px;';

		const label = $('span.forge-msg-label');
		label.textContent = localize('forge.msg.you', "You");
		label.style.cssText = 'font-size: 12px; font-weight: 500; color: #888780;';
		header.appendChild(label);

		const ts = $('span.forge-msg-ts');
		ts.textContent = this._formatTime(new Date());
		ts.style.cssText = 'font-size: 11px; color: #444441; margin-left: auto;';
		header.appendChild(ts);

		msg.appendChild(header);

		// Image attachment (if any)
		if (imageHtml) {
			const imgContainer = $('div.forge-msg-image');
			this._setTrustedHtml(imgContainer, imageHtml);
			imgContainer.style.cssText = 'margin-bottom: 8px;';
			const imgs = imgContainer.querySelectorAll('img');
			for (const img of imgs) {
				(img as HTMLElement).style.cssText = 'max-width: 200px; border-radius: 8px; cursor: pointer;';
			}
			msg.appendChild(imgContainer);
		}

		// Text content
		const text = $('div.forge-msg-text');
		text.style.cssText = 'font-size: 13px; color: #e8e6de; line-height: 1.6; white-space: pre-wrap; word-break: break-word;';
		this._setTrustedHtml(text, this._renderMarkdown(content));
		msg.appendChild(text);

		this._container.appendChild(msg);
		this._scrollToBottom();
	}

	appendAssistantMessage(content: string, verification?: VerificationSummary): void {
		this._removeThinking();
		const msg = $('div.forge-msg.forge-msg-assistant');
		msg.style.cssText = 'padding: 12px 0; border-bottom: 1px solid #2e2d28;';

		// Header row
		const header = $('div.forge-msg-header');
		header.style.cssText = 'display: flex; align-items: center; margin-bottom: 6px;';

		const label = $('span.forge-msg-label');
		label.textContent = localize('forge.msg.forge', "Forge");
		label.style.cssText = 'font-size: 12px; font-weight: 500; color: #EF9F27;';
		header.appendChild(label);

		const ts = $('span.forge-msg-ts');
		ts.textContent = this._formatTime(new Date());
		ts.style.cssText = 'font-size: 11px; color: #444441; margin-left: auto;';
		header.appendChild(ts);

		msg.appendChild(header);

		// Text content
		const text = $('div.forge-msg-text');
		text.style.cssText = 'font-size: 13px; color: #e8e6de; line-height: 1.6; white-space: pre-wrap; word-break: break-word;';
		this._setTrustedHtml(text, this._renderMarkdown(content));
		msg.appendChild(text);

		// Verification summary (if present)
		if (verification) {
			msg.appendChild(this._createVerificationSummary(verification));
		}

		this._container.appendChild(msg);
		this._scrollToBottom();
	}

	showThinking(actionText?: string): void {
		this._removeThinking();

		this._thinkingElement = $('div.forge-msg.forge-msg-thinking');
		this._thinkingElement.style.cssText = 'padding: 12px 0; border-bottom: 1px solid #2e2d28;';

		// Header
		const header = $('div.forge-msg-header');
		header.style.cssText = 'display: flex; align-items: center; margin-bottom: 6px;';
		const label = $('span.forge-msg-label');
		label.textContent = localize('forge.msg.forge', "Forge");
		label.style.cssText = 'font-size: 12px; font-weight: 500; color: #EF9F27;';
		header.appendChild(label);
		this._thinkingElement.appendChild(header);

		// Animated dots
		const dotsRow = $('div.forge-thinking-dots');
		dotsRow.style.cssText = 'display: flex; gap: 4px; margin-bottom: 6px;';

		for (let i = 0; i < 3; i++) {
			const dot = $('span.forge-dot');
			dot.style.cssText = `width: 6px; height: 6px; border-radius: 50%; background: #EF9F27; animation: forgePulse 0.6s ease-in-out infinite; animation-delay: ${i * 0.15}s;`;
			dotsRow.appendChild(dot);
		}

		this._thinkingElement.appendChild(dotsRow);

		// Action text
		const action = $('div.forge-thinking-action');
		action.textContent = actionText ?? '';
		action.style.cssText = 'font-size: 12px; color: #5F5E5A;';
		this._thinkingElement.appendChild(action);

		// Inject animation keyframes if not already present
		this._ensurePulseAnimation();

		this._container.appendChild(this._thinkingElement);
		this._scrollToBottom();
	}

	updateThinkingAction(actionText: string): void {
		if (this._thinkingElement) {
			const action = this._thinkingElement.querySelector('.forge-thinking-action');
			if (action) {
				action.textContent = actionText;
			}
		}
	}

	startStreaming(): void {
		this._removeThinking();
		const msg = $('div.forge-msg.forge-msg-assistant.forge-msg-streaming');
		msg.style.cssText = 'padding: 12px 0; border-bottom: 1px solid #2e2d28;';

		const header = $('div.forge-msg-header');
		header.style.cssText = 'display: flex; align-items: center; margin-bottom: 6px;';
		const label = $('span.forge-msg-label');
		label.textContent = localize('forge.msg.forge', "Forge");
		label.style.cssText = 'font-size: 12px; font-weight: 500; color: #EF9F27;';
		header.appendChild(label);

		const ts = $('span.forge-msg-ts');
		ts.textContent = this._formatTime(new Date());
		ts.style.cssText = 'font-size: 11px; color: #444441; margin-left: auto;';
		header.appendChild(ts);
		msg.appendChild(header);

		const text = $('div.forge-msg-text');
		text.style.cssText = 'font-size: 13px; color: #e8e6de; line-height: 1.6; white-space: pre-wrap; word-break: break-word;';
		msg.appendChild(text);

		this._container.appendChild(msg);
		this._scrollToBottom();
	}

	updateStreaming(content: string): void {
		const el = this._container.querySelector('.forge-msg-streaming .forge-msg-text') as HTMLElement | null;
		if (el) {
			this._setTrustedHtml(el, this._renderMarkdown(content));
			this._scrollToBottom();
		}
	}

	finalizeStreaming(): void {
		const el = this._container.querySelector('.forge-msg-streaming');
		if (el) {
			el.classList.remove('forge-msg-streaming');
		}
	}

	appendErrorMessage(error: string): void {
		this._removeThinking();
		const msg = $('div.forge-msg.forge-msg-error');
		msg.style.cssText = 'padding: 12px 0; border-bottom: 1px solid #2e2d28;';

		const header = $('div.forge-msg-header');
		header.style.cssText = 'margin-bottom: 6px;';
		const label = $('span.forge-msg-label');
		label.textContent = localize('forge.msg.forge', "Forge");
		label.style.cssText = 'font-size: 12px; font-weight: 500; color: #E24B4A;';
		header.appendChild(label);
		msg.appendChild(header);

		const text = $('div.forge-msg-text');
		text.style.cssText = 'font-size: 13px; color: #E24B4A; line-height: 1.6;';
		text.textContent = error;
		msg.appendChild(text);

		this._container.appendChild(msg);
		this._scrollToBottom();
	}

	private _removeThinking(): void {
		if (this._thinkingElement) {
			this._thinkingElement.remove();
			this._thinkingElement = undefined;
		}
	}

	private _createVerificationSummary(v: VerificationSummary): HTMLElement {
		const box = $('div.forge-verification');
		box.style.cssText = 'background: #27261f; border: 1px solid #3a382f; border-radius: 6px; padding: 8px 12px; margin-top: 8px; font-size: 11px; display: flex; gap: 12px; cursor: pointer;';

		const items: string[] = [];

		// Types
		items.push(this._verificationItem('Types', v.types));

		// Tests
		if (v.tests.status === 'pass') {
			items.push(`<span style="color: #5DCAA5;">\u2713</span> Tests${v.tests.count ? ` (${v.tests.count} passed)` : ''}`);
		} else if (v.tests.status === 'fail') {
			items.push(`<span style="color: #E24B4A;">\u2717</span> Tests${v.tests.count ? ` (${v.tests.count} failed)` : ''}`);
		}

		// Imports
		items.push(this._verificationItem('Imports', v.imports));

		// Coverage
		if (v.coverage !== undefined) {
			items.push(`<span style="color: #5F5E5A;">${v.coverage}% cov</span>`);
		}

		this._setTrustedHtml(box, items.join('<span style="color: #3a382f; margin: 0 2px;">\u00b7</span>'));

		box.addEventListener('click', () => this._onDidClickVerification.fire());
		box.addEventListener('mouseenter', () => { box.style.borderColor = '#4a483f'; });
		box.addEventListener('mouseleave', () => { box.style.borderColor = '#3a382f'; });

		return box;
	}

	private _verificationItem(label: string, status: 'pass' | 'fail' | 'skip'): string {
		if (status === 'pass') {
			return `<span style="color: #5DCAA5;">\u2713</span> ${label}`;
		} else if (status === 'fail') {
			return `<span style="color: #E24B4A;">\u2717</span> ${label}`;
		}
		return `<span style="color: #EF9F27;">\u2013</span> ${label}`;
	}

	private _renderMarkdown(content: string): string {
		// Lightweight markdown rendering: code blocks, inline code, bold, italic
		let html = this._escapeHtml(content);

		// Code blocks
		html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
			const header = lang ? `<div style="font-size: 10px; color: #5F5E5A; padding: 4px 10px; border-bottom: 1px solid #3a382f;">${lang}</div>` : '';
			return `<div style="background: #27261f; border: 1px solid #3a382f; border-radius: 6px; margin: 8px 0; overflow: hidden;">${header}<pre style="padding: 8px 10px; margin: 0; font-family: monospace; font-size: 12px; overflow-x: auto;">${code}</pre></div>`;
		});

		// Inline code
		html = html.replace(/`([^`]+)`/g, '<code style="background: #27261f; border: 1px solid #3a382f; border-radius: 3px; padding: 1px 4px; font-family: monospace; font-size: 12px;">$1</code>');

		// Bold
		html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

		// Italic
		html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

		return html;
	}

	private _escapeHtml(str: string): string {
		return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	private _formatTime(date: Date): string {
		return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	}

	private _scrollToBottom(): void {
		this._container.scrollTop = this._container.scrollHeight;
	}

	private _setTrustedHtml(el: HTMLElement, html: string): void {
		el.innerHTML = (ttPolicy?.createHTML(html) ?? html) as unknown as string;
	}

	private _ensurePulseAnimation(): void {
		if (document.getElementById('forge-pulse-style')) {
			return;
		}
		const style = document.createElement('style');
		style.id = 'forge-pulse-style';
		style.textContent = '@keyframes forgePulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }';
		document.head.appendChild(style);
	}
}
