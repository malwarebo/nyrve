/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { ImageAttachment } from './image-input.js';
import { INyrveVisionApi, ContentBlock } from './vision-api.js';
import { INyrveImageProcessor } from './image-processor.js';
import { PlanRequest } from '../plan/plan-types.js';

// --- Types ---

export interface VisionPlanRequest extends PlanRequest {
	readonly images: readonly ImageAttachment[];
}

// --- Service Interface ---

export const INyrveVisionPlanIntegration = createDecorator<INyrveVisionPlanIntegration>('nyrveVisionPlanIntegration');

export interface INyrveVisionPlanIntegration {
	readonly _serviceBrand: undefined;

	/**
	 * Build content blocks for a plan generation request that includes images.
	 * Used when the user pastes a design mockup or screenshot and asks
	 * the agent to create a plan from it.
	 */
	buildPlanRequestContent(request: VisionPlanRequest): Promise<ContentBlock[]>;

	/**
	 * Estimate total tokens for a vision-enhanced plan request.
	 */
	estimateRequestTokens(request: VisionPlanRequest): number;
}

// --- Implementation ---

export class NyrveVisionPlanIntegration extends Disposable implements INyrveVisionPlanIntegration {
	declare readonly _serviceBrand: undefined;

	constructor(
		@INyrveVisionApi private readonly visionApi: INyrveVisionApi,
		@INyrveImageProcessor private readonly imageProcessor: INyrveImageProcessor,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async buildPlanRequestContent(request: VisionPlanRequest): Promise<ContentBlock[]> {
		const textParts: string[] = [];

		textParts.push(request.userMessage);

		if (request.activeFile) {
			textParts.push(`\nActive file: ${request.activeFile}`);
		}

		if (request.selectedCode) {
			textParts.push(`\nSelected code:\n\`\`\`\n${request.selectedCode}\n\`\`\``);
		}

		if (request.mentionedFiles && request.mentionedFiles.length > 0) {
			textParts.push(`\nReferenced files: ${request.mentionedFiles.join(', ')}`);
		}

		if (request.images.length > 0) {
			textParts.push(`\n${request.images.length} image(s) attached. Use these to understand the requirements.`);
		}

		const text = textParts.join('\n');

		// Build content blocks with images
		const blocks = await this.visionApi.buildContentBlocks(text, request.images);

		this.logService.trace(`[Nyrve] Vision plan request: ${blocks.length} content blocks (${request.images.length} images)`);
		return blocks;
	}

	estimateRequestTokens(request: VisionPlanRequest): number {
		const textTokens = Math.ceil(request.userMessage.length / 4);
		let imageTokens = 0;

		for (const image of request.images) {
			imageTokens += this.imageProcessor.estimateTokens(image.width, image.height);
		}

		return textTokens + imageTokens;
	}
}

registerSingleton(INyrveVisionPlanIntegration, NyrveVisionPlanIntegration, InstantiationType.Delayed);
