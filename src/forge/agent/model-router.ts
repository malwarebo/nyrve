/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { ForgeModelId, IForgeConfigService } from '../core/config.js';

// --- Anthropic API model identifiers ---

const MODEL_API_IDS: Record<ForgeModelId, string> = {
	'claude-opus': 'claude-opus-4-6',
	'claude-sonnet': 'claude-sonnet-4-6',
	'claude-haiku': 'claude-haiku-4-5-20251001',
};

// --- Types ---

export const enum ForgeTaskComplexity {
	/** Simple queries, quick completions, background suggestions */
	Low = 'low',
	/** General chat, single-file edits, explanations */
	Medium = 'medium',
	/** Multi-file refactors, planning, complex reasoning */
	High = 'high',
}

// --- Service Interface ---

export const IForgeModelRouter = createDecorator<IForgeModelRouter>('forgeModelRouter');

export interface IForgeModelRouter {
	readonly _serviceBrand: undefined;

	/** Get the API model ID string for a Forge model. */
	getApiModelId(model: ForgeModelId): string;

	/** Select the best model for a given task complexity. */
	selectModel(complexity: ForgeTaskComplexity): ForgeModelId;

	/** Get the model for interactive chat (user's default). */
	getChatModel(): ForgeModelId;

	/** Get the model for background agent tasks. */
	getBackgroundModel(): ForgeModelId;

	/** Get all available model IDs. */
	getAvailableModels(): ForgeModelId[];
}

// --- Service Implementation ---

export class ForgeModelRouter extends Disposable implements IForgeModelRouter {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IForgeConfigService private readonly configService: IForgeConfigService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	getApiModelId(model: ForgeModelId): string {
		return MODEL_API_IDS[model];
	}

	selectModel(complexity: ForgeTaskComplexity): ForgeModelId {
		let model: ForgeModelId;
		switch (complexity) {
			case ForgeTaskComplexity.High:
				model = this.configService.getComplexTaskModel();
				break;
			case ForgeTaskComplexity.Medium:
				model = this.configService.getDefaultModel();
				break;
			case ForgeTaskComplexity.Low:
				model = this.configService.getBackgroundModel();
				break;
		}
		this.logService.trace(`[Forge] Model router: complexity=${complexity} → model=${model}`);
		return model;
	}

	getChatModel(): ForgeModelId {
		return this.configService.getDefaultModel();
	}

	getBackgroundModel(): ForgeModelId {
		return this.configService.getBackgroundModel();
	}

	getAvailableModels(): ForgeModelId[] {
		return ['claude-opus', 'claude-sonnet', 'claude-haiku'];
	}
}

registerSingleton(IForgeModelRouter, ForgeModelRouter, InstantiationType.Delayed);
