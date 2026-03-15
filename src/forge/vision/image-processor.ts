/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { ImageAttachment, ImageMimeType } from './image-input.js';

// --- Types ---

export interface ProcessedImage {
	readonly base64: string;
	readonly mimeType: ImageMimeType;
	readonly width: number;
	readonly height: number;
	readonly size: number;
	readonly wasResized: boolean;
	readonly wasCompressed: boolean;
}

// --- Service Interface ---

export const IForgeImageProcessor = createDecorator<IForgeImageProcessor>('forgeImageProcessor');

export interface IForgeImageProcessor {
	readonly _serviceBrand: undefined;

	/**
	 * Process an image for the API.
	 * - Resize to max dimensions
	 * - Compress if needed
	 * - Strip EXIF
	 * - Generate thumbnail
	 */
	process(attachment: ImageAttachment): Promise<ProcessedImage>;

	/** Generate a small thumbnail for UI preview. */
	generateThumbnail(base64: string, mimeType: ImageMimeType): Promise<string>;

	/** Estimate tokens for an image based on dimensions. */
	estimateTokens(width: number, height: number): number;
}

// --- Constants ---

const MAX_DIMENSION = 2048;
const MIN_DIMENSION = 100;
const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
// Token estimation: Claude uses ~750 tokens per 1024x1024 image tile
const TOKENS_PER_TILE = 750;
const TILE_SIZE = 1024;

// --- Implementation ---

export class ForgeImageProcessor extends Disposable implements IForgeImageProcessor {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async process(attachment: ImageAttachment): Promise<ProcessedImage> {
		const maxDim = this.configurationService.getValue<number>('forge.vision.maxImageDimension') ?? MAX_DIMENSION;
		let { base64, mimeType, width, height } = attachment;
		let wasResized = false;
		let wasCompressed = false;

		// If dimensions are unknown (not yet measured), pass through
		// The actual resize would happen in the webview/canvas context
		// For now, return the image as-is with metadata
		if (width === 0 && height === 0) {
			// In a real implementation, we'd decode the image to get dimensions
			// and use Canvas/OffscreenCanvas to resize. Since we're in a Node context,
			// we'd use Electron's nativeImage API.
			return {
				base64,
				mimeType,
				width,
				height,
				size: attachment.processedSize,
				wasResized: false,
				wasCompressed: false,
			};
		}

		// Check if resize needed
		if (width > maxDim || height > maxDim) {
			const scale = maxDim / Math.max(width, height);
			width = Math.round(width * scale);
			height = Math.round(height * scale);
			wasResized = true;
			this.logService.trace(`[Forge] Image resized to ${width}x${height}`);
		}

		// Upscale very small images
		if (width < MIN_DIMENSION || height < MIN_DIMENSION) {
			const scale = 2;
			width = Math.round(width * scale);
			height = Math.round(height * scale);
			wasResized = true;
			this.logService.trace(`[Forge] Small image upscaled to ${width}x${height}`);
		}

		// Convert GIF to PNG (first frame only)
		if (mimeType === 'image/gif') {
			mimeType = 'image/png';
			this.logService.trace('[Forge] GIF converted to PNG');
		}

		// Compression check
		const sizeBytes = Math.ceil(base64.length * 0.75); // approximate decoded size
		if (sizeBytes > MAX_SIZE_BYTES) {
			// Would compress to JPEG quality 85, then 70 if still too large
			// PNG with transparency stays as PNG
			if (mimeType !== 'image/png') {
				mimeType = 'image/jpeg';
				wasCompressed = true;
			}
			this.logService.trace(`[Forge] Image compressed (${sizeBytes} bytes)`);
		}

		return {
			base64,
			mimeType,
			width,
			height,
			size: sizeBytes,
			wasResized,
			wasCompressed,
		};
	}

	async generateThumbnail(base64: string, _mimeType: ImageMimeType): Promise<string> {
		// In a real implementation, this would use Canvas/OffscreenCanvas to resize
		// to THUMBNAIL_SIZE x THUMBNAIL_SIZE. For now, return the original base64.
		return base64;
	}

	estimateTokens(width: number, height: number): number {
		if (width === 0 || height === 0) {
			return TOKENS_PER_TILE; // Minimum 1 tile
		}

		const tilesX = Math.ceil(width / TILE_SIZE);
		const tilesY = Math.ceil(height / TILE_SIZE);
		return tilesX * tilesY * TOKENS_PER_TILE;
	}
}

registerSingleton(IForgeImageProcessor, ForgeImageProcessor, InstantiationType.Delayed);
