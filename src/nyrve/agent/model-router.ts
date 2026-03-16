/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { NyrveModelId, INyrveConfigService } from '../core/config.js';

// --- Anthropic API model identifiers ---

const MODEL_API_IDS: Record<NyrveModelId, string> = {
	'claude-opus': 'claude-opus-4-6',
	'claude-sonnet': 'claude-sonnet-4-6',
	'claude-haiku': 'claude-haiku-4-5-20251001',
};

// --- Types ---

export const enum NyrveTaskComplexity {
	/** Simple queries, quick completions, background suggestions */
	Low = 'low',
	/** General chat, single-file edits, explanations */
	Medium = 'medium',
	/** Multi-file refactors, planning, complex reasoning */
	High = 'high',
}

// --- Service Interface ---

export const INyrveModelRouter = createDecorator<INyrveModelRouter>('nyrveModelRouter');

export interface INyrveModelRouter {
	readonly _serviceBrand: undefined;

	/** Get the API model ID string for a Nyrve model. */
	getApiModelId(model: NyrveModelId): string;

	/** Select the best model for a given task complexity. */
	selectModel(complexity: NyrveTaskComplexity): NyrveModelId;

	/** Get the model for interactive chat (user's default). */
	getChatModel(): NyrveModelId;

	/** Get the model for background agent tasks. */
	getBackgroundModel(): NyrveModelId;

	/** Get all available model IDs. */
	getAvailableModels(): NyrveModelId[];
}

// --- Service Implementation ---

export class NyrveModelRouter extends Disposable implements INyrveModelRouter {
	declare readonly _serviceBrand: undefined;

	constructor(
		@INyrveConfigService private readonly configService: INyrveConfigService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	getApiModelId(model: NyrveModelId): string {
		return MODEL_API_IDS[model];
	}

	selectModel(complexity: NyrveTaskComplexity): NyrveModelId {
		let model: NyrveModelId;
		switch (complexity) {
			case NyrveTaskComplexity.High:
				model = this.configService.getComplexTaskModel();
				break;
			case NyrveTaskComplexity.Medium:
				model = this.configService.getDefaultModel();
				break;
			case NyrveTaskComplexity.Low:
				model = this.configService.getBackgroundModel();
				break;
		}
		this.logService.trace(`[Nyrve] Model router: complexity=${complexity} → model=${model}`);
		return model;
	}

	getChatModel(): NyrveModelId {
		return this.configService.getDefaultModel();
	}

	getBackgroundModel(): NyrveModelId {
		return this.configService.getBackgroundModel();
	}

	getAvailableModels(): NyrveModelId[] {
		return ['claude-opus', 'claude-sonnet', 'claude-haiku'];
	}
}

registerSingleton(INyrveModelRouter, NyrveModelRouter, InstantiationType.Delayed);
