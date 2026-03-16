/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { Emitter, Event } from '../../vs/base/common/event.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { IFileDialogService } from '../../vs/platform/dialogs/common/dialogs.js';
import { IFileService } from '../../vs/platform/files/common/files.js';
import { URI } from '../../vs/base/common/uri.js';

// --- Types ---

export type ImageSource = 'clipboard' | 'file' | 'drag_drop' | 'screenshot' | 'mention';
export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface ImageAttachment {
	readonly id: string;
	readonly source: ImageSource;
	readonly originalFilename?: string;
	readonly base64: string;
	readonly mimeType: ImageMimeType;
	readonly width: number;
	readonly height: number;
	readonly resized: boolean;
	readonly originalSize: number;
	readonly processedSize: number;
	readonly thumbnailBase64: string;
}

// --- Service Interface ---

export const INyrveImageInput = createDecorator<INyrveImageInput>('nyrveImageInput');

export interface INyrveImageInput {
	readonly _serviceBrand: undefined;

	/** Fires when an image is attached. */
	readonly onDidAttachImage: Event<ImageAttachment>;

	/** Handle paste from clipboard. */
	handlePaste(data: DataTransfer): Promise<ImageAttachment | undefined>;

	/** Handle drag and drop. */
	handleDrop(data: DataTransfer): Promise<ImageAttachment | undefined>;

	/** Open file picker for images. */
	openFilePicker(): Promise<ImageAttachment | undefined>;

	/** Capture a screenshot using OS tools. */
	captureScreenshot(): Promise<ImageAttachment | undefined>;

	/** Handle @image mention. */
	handleImageMention(path: string): Promise<ImageAttachment | undefined>;

	/** Remove an attachment. */
	removeAttachment(id: string): void;

	/** Get current attachments. */
	getAttachments(): readonly ImageAttachment[];

	/** Clear all attachments. */
	clearAttachments(): void;
}

// --- Constants ---

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const SUPPORTED_TYPES: ImageMimeType[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

// --- Implementation ---

export class NyrveImageInput extends Disposable implements INyrveImageInput {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidAttachImage = this._register(new Emitter<ImageAttachment>());
	readonly onDidAttachImage = this._onDidAttachImage.event;

	private _attachments: ImageAttachment[] = [];

	constructor(
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async handlePaste(data: DataTransfer): Promise<ImageAttachment | undefined> {
		// Look for image items in the data transfer
		for (let i = 0; i < data.items.length; i++) {
			const item = data.items[i];
			if (item.kind === 'file' && this._isSupportedMime(item.type)) {
				const file = item.getAsFile();
				if (file && file.size <= MAX_FILE_SIZE) {
					return this._processFile(file, 'clipboard');
				}
			}
		}
		return undefined;
	}

	async handleDrop(data: DataTransfer): Promise<ImageAttachment | undefined> {
		for (let i = 0; i < data.files.length; i++) {
			const file = data.files[i];
			if (this._isSupportedMime(file.type) && file.size <= MAX_FILE_SIZE) {
				return this._processFile(file, 'drag_drop');
			}
		}
		return undefined;
	}

	async openFilePicker(): Promise<ImageAttachment | undefined> {
		const result = await this.fileDialogService.showOpenDialog({
			title: 'Attach Image',
			filters: [
				{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
			],
			canSelectMany: false,
		});

		if (!result || result.length === 0) {
			return undefined;
		}

		return this._processUri(result[0], 'file');
	}

	async captureScreenshot(): Promise<ImageAttachment | undefined> {
		// Screenshot capture is platform-specific and uses Electron APIs.
		// This is a placeholder — the actual implementation would use
		// electron's desktopCapturer or shell out to OS screenshot tools.
		this.logService.info('[Nyrve] Screenshot capture requested (platform-specific)');
		return undefined;
	}

	async handleImageMention(path: string): Promise<ImageAttachment | undefined> {
		const uri = URI.file(path);
		return this._processUri(uri, 'mention');
	}

	removeAttachment(id: string): void {
		this._attachments = this._attachments.filter(a => a.id !== id);
	}

	getAttachments(): readonly ImageAttachment[] {
		return this._attachments;
	}

	clearAttachments(): void {
		this._attachments = [];
	}

	private async _processFile(file: File, source: ImageSource): Promise<ImageAttachment | undefined> {
		try {
			const buffer = await file.arrayBuffer();
			const base64 = this._arrayBufferToBase64(buffer);
			const mimeType = this._normalizeMime(file.type);

			const attachment: ImageAttachment = {
				id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
				source,
				originalFilename: file.name,
				base64,
				mimeType,
				width: 0, // Will be set by image processor
				height: 0,
				resized: false,
				originalSize: file.size,
				processedSize: buffer.byteLength,
				thumbnailBase64: base64, // Actual thumbnail generated by processor
			};

			this._attachments.push(attachment);
			this._onDidAttachImage.fire(attachment);
			this.logService.trace(`[Nyrve] Image attached: ${source} (${file.name}, ${file.size} bytes)`);
			return attachment;
		} catch (e) {
			this.logService.warn('[Nyrve] Failed to process image file', e);
			return undefined;
		}
	}

	private async _processUri(uri: URI, source: ImageSource): Promise<ImageAttachment | undefined> {
		try {
			const content = await this.fileService.readFile(uri);
			const uint8 = content.value.buffer;
			const base64 = this._uint8ArrayToBase64(uint8);

			const ext = uri.path.split('.').pop()?.toLowerCase() ?? '';
			const mimeType = this._extToMime(ext);

			if (!mimeType) {
				this.logService.warn(`[Nyrve] Unsupported image format: ${ext}`);
				return undefined;
			}

			const attachment: ImageAttachment = {
				id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
				source,
				originalFilename: uri.path.split('/').pop(),
				base64,
				mimeType,
				width: 0,
				height: 0,
				resized: false,
				originalSize: uint8.byteLength,
				processedSize: uint8.byteLength,
				thumbnailBase64: base64,
			};

			this._attachments.push(attachment);
			this._onDidAttachImage.fire(attachment);
			this.logService.trace(`[Nyrve] Image attached from URI: ${source}`);
			return attachment;
		} catch (e) {
			this.logService.warn('[Nyrve] Failed to process image URI', e);
			return undefined;
		}
	}

	private _isSupportedMime(type: string): boolean {
		return SUPPORTED_TYPES.includes(type as ImageMimeType);
	}

	private _normalizeMime(type: string): ImageMimeType {
		if (SUPPORTED_TYPES.includes(type as ImageMimeType)) {
			return type as ImageMimeType;
		}
		return 'image/png'; // Default fallback
	}

	private _extToMime(ext: string): ImageMimeType | undefined {
		switch (ext) {
			case 'png': return 'image/png';
			case 'jpg':
			case 'jpeg': return 'image/jpeg';
			case 'gif': return 'image/gif';
			case 'webp': return 'image/webp';
			default: return undefined;
		}
	}

	private _arrayBufferToBase64(buffer: ArrayBuffer): string {
		return this._uint8ArrayToBase64(new Uint8Array(buffer));
	}

	private _uint8ArrayToBase64(bytes: Uint8Array): string {
		let binary = '';
		for (let i = 0; i < bytes.byteLength; i++) {
			binary += String.fromCharCode(bytes[i]);
		}
		return btoa(binary);
	}
}

registerSingleton(INyrveImageInput, NyrveImageInput, InstantiationType.Delayed);
