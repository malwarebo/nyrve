/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { ImageAttachment, ImageMimeType } from './image-input.js';
import { IForgeImageProcessor, ProcessedImage } from './image-processor.js';

// --- Types ---

/**
 * A text content block for the Anthropic Messages API.
 */
export interface TextContentBlock {
	readonly type: 'text';
	readonly text: string;
}

/**
 * An image content block for the Anthropic Messages API.
 * Uses base64-encoded image data.
 */
export interface ImageContentBlock {
	readonly type: 'image';
	readonly source: {
		readonly type: 'base64';
		readonly media_type: ImageMimeType;
		readonly data: string;
	};
}

export type ContentBlock = TextContentBlock | ImageContentBlock;

/**
 * A message with mixed text and image content for the API.
 */
export interface VisionMessage {
	readonly role: 'user' | 'assistant';
	readonly content: ContentBlock[];
}

// --- Service Interface ---

export const IForgeVisionApi = createDecorator<IForgeVisionApi>('forgeVisionApi');

export interface IForgeVisionApi {
	readonly _serviceBrand: undefined;

	/**
	 * Build content blocks for a message with images.
	 * Processes images and creates the content array for the Anthropic API.
	 */
	buildContentBlocks(text: string, images: readonly ImageAttachment[]): Promise<ContentBlock[]>;

	/**
	 * Build a full VisionMessage from text and images.
	 */
	buildMessage(role: 'user' | 'assistant', text: string, images: readonly ImageAttachment[]): Promise<VisionMessage>;

	/**
	 * Estimate total tokens for a message with images.
	 */
	estimateTokens(text: string, images: readonly ImageAttachment[]): number;

	/**
	 * Check if a message has image attachments.
	 */
	hasImages(content: ContentBlock[]): boolean;
}

// --- Implementation ---

export class ForgeVisionApi extends Disposable implements IForgeVisionApi {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IForgeImageProcessor private readonly imageProcessor: IForgeImageProcessor,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async buildContentBlocks(text: string, images: readonly ImageAttachment[]): Promise<ContentBlock[]> {
		const blocks: ContentBlock[] = [];

		// Process and add images first (Claude sees images before text for better understanding)
		for (const image of images) {
			try {
				const processed: ProcessedImage = await this.imageProcessor.process(image);

				blocks.push({
					type: 'image',
					source: {
						type: 'base64',
						media_type: processed.mimeType,
						data: processed.base64,
					},
				});

				this.logService.trace(`[Forge] Vision: added image block (${processed.width}x${processed.height}, ${processed.mimeType})`);
			} catch (e) {
				this.logService.warn(`[Forge] Vision: failed to process image ${image.id}`, e);
			}
		}

		// Add text block
		if (text.length > 0) {
			blocks.push({
				type: 'text',
				text,
			});
		}

		return blocks;
	}

	async buildMessage(role: 'user' | 'assistant', text: string, images: readonly ImageAttachment[]): Promise<VisionMessage> {
		const content = await this.buildContentBlocks(text, images);
		return { role, content };
	}

	estimateTokens(text: string, images: readonly ImageAttachment[]): number {
		// Text tokens: ~4 chars per token
		let tokens = Math.ceil(text.length / 4);

		// Image tokens
		for (const image of images) {
			tokens += this.imageProcessor.estimateTokens(image.width, image.height);
		}

		return tokens;
	}

	hasImages(content: ContentBlock[]): boolean {
		return content.some(block => block.type === 'image');
	}
}

registerSingleton(IForgeVisionApi, ForgeVisionApi, InstantiationType.Delayed);
