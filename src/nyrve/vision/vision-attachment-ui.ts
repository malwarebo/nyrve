/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { Emitter, Event } from '../../vs/base/common/event.js';
import { localize } from '../../vs/nls.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { INyrveImageInput, ImageAttachment } from './image-input.js';

// --- Types ---

export interface AttachmentUIState {
	readonly attachments: readonly ImageAttachment[];
	readonly showDropZone: boolean;
}

// --- Service Interface ---

export const INyrveVisionAttachmentUI = createDecorator<INyrveVisionAttachmentUI>('nyrveVisionAttachmentUI');

export interface INyrveVisionAttachmentUI {
	readonly _serviceBrand: undefined;

	/** Current UI state. */
	readonly state: AttachmentUIState;

	/** Fires when attachment UI state changes. */
	readonly onDidChangeState: Event<AttachmentUIState>;

	/** Show the drop zone indicator. */
	showDropZone(): void;

	/** Hide the drop zone indicator. */
	hideDropZone(): void;

	/** Get HTML for the attachment preview bar. */
	getPreviewBarHtml(): string;

	/** Get HTML for an image displayed in chat history. */
	getChatImageHtml(attachment: ImageAttachment): string;

	/** Get HTML for the attachment toolbar buttons. */
	getToolbarHtml(): string;
}

// --- Implementation ---

export class NyrveVisionAttachmentUI extends Disposable implements INyrveVisionAttachmentUI {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<AttachmentUIState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private _showDropZone = false;

	get state(): AttachmentUIState {
		return {
			attachments: this.imageInput.getAttachments(),
			showDropZone: this._showDropZone,
		};
	}

	constructor(
		@INyrveImageInput private readonly imageInput: INyrveImageInput,
		@ILogService _logService: ILogService,
	) {
		super();

		this._register(this.imageInput.onDidAttachImage(() => {
			this._fireStateChange();
		}));
	}

	showDropZone(): void {
		this._showDropZone = true;
		this._fireStateChange();
	}

	hideDropZone(): void {
		this._showDropZone = false;
		this._fireStateChange();
	}

	getPreviewBarHtml(): string {
		const attachments = this.imageInput.getAttachments();
		if (attachments.length === 0) {
			return '';
		}

		const previews = attachments.map(a => `
<div class="attachment-preview" data-id="${a.id}" style="display: inline-block; position: relative; margin: 4px;">
	<img src="data:${a.mimeType};base64,${a.thumbnailBase64}" alt="${this._escapeHtml(a.originalFilename ?? 'image')}" style="width: 48px; height: 48px; object-fit: cover; border-radius: 4px; border: 1px solid var(--vscode-panel-border);" />
	<button class="attachment-remove" data-id="${a.id}" style="position: absolute; top: -4px; right: -4px; width: 16px; height: 16px; border-radius: 50%; background: var(--vscode-errorForeground); color: white; border: none; cursor: pointer; font-size: 10px; line-height: 16px; padding: 0;" title="${localize('nyrve.vision.remove', "Remove image")}">\u00d7</button>
</div>`).join('');

		return `<div class="attachments-bar" style="padding: 4px 8px; border-top: 1px solid var(--vscode-panel-border);">${previews}</div>`;
	}

	getChatImageHtml(attachment: ImageAttachment): string {
		const sizeKb = Math.round(attachment.processedSize / 1024);
		return `
<div class="chat-image" style="margin: 8px 0;">
	<img src="data:${attachment.mimeType};base64,${attachment.thumbnailBase64}" alt="${this._escapeHtml(attachment.originalFilename ?? 'image')}" style="max-width: 300px; max-height: 200px; border-radius: 4px; border: 1px solid var(--vscode-panel-border); cursor: pointer;" title="${localize('nyrve.vision.clickToEnlarge', "Click to enlarge")}" />
	<div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px;">
		${this._escapeHtml(attachment.originalFilename ?? 'image')} \u00b7 ${sizeKb}KB
		${attachment.resized ? ' \u00b7 resized' : ''}
	</div>
</div>`;
	}

	getToolbarHtml(): string {
		return `
<div class="vision-toolbar" style="display: inline-flex; gap: 4px;">
	<button class="vision-btn" data-action="file-picker" title="${localize('nyrve.vision.attachImage', "Attach Image")}" style="background: none; border: none; cursor: pointer; padding: 4px; color: var(--vscode-foreground);">\u{1F4CE}</button>
	<button class="vision-btn" data-action="screenshot" title="${localize('nyrve.vision.screenshot', "Capture Screenshot")}" style="background: none; border: none; cursor: pointer; padding: 4px; color: var(--vscode-foreground);">\u{1F4F7}</button>
</div>`;
	}

	private _fireStateChange(): void {
		this._onDidChangeState.fire(this.state);
	}

	private _escapeHtml(str: string): string {
		return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}
}

registerSingleton(INyrveVisionAttachmentUI, NyrveVisionAttachmentUI, InstantiationType.Delayed);
