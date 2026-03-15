/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from '../../vs/base/common/event.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import { ISecretStorageService } from '../../vs/platform/secrets/common/secrets.js';
import { ILogService } from '../../vs/platform/log/common/log.js';

// --- Constants ---

export const FORGE_SCHEME = 'forge';
export const FORGE_DATA_DIR = '.forge';
export const FORGE_CONFIG_FILE = 'config.json';
export const FORGE_SETTINGS_PREFIX = 'forge';
export const FORGE_API_KEY_SECRET = 'forge.anthropicApiKey';

// --- Settings Key Enums ---

export const enum ForgeAgentSettingId {
	ConfirmationLevel = 'forge.agent.confirmationLevel',
	DefaultModel = 'forge.agent.defaultModel',
	ComplexTaskModel = 'forge.agent.complexTaskModel',
	BackgroundModel = 'forge.agent.backgroundModel',
	ModelSwitcher = 'forge.agent.modelSwitcher',
	MaxTokensPerRequest = 'forge.agent.maxTokensPerRequest',
	StreamResponses = 'forge.agent.streamResponses',
}

export const enum ForgeBackgroundAgentSettingId {
	Enabled = 'forge.backgroundAgent.enabled',
	Mode = 'forge.backgroundAgent.mode',
	MinSeverity = 'forge.backgroundAgent.minSeverity',
	DailyTokenBudget = 'forge.backgroundAgent.dailyTokenBudget',
	DisabledCategories = 'forge.backgroundAgent.disabledCategories',
}

export const enum ForgeIndexerSettingId {
	Enabled = 'forge.indexer.enabled',
	EmbeddingModel = 'forge.indexer.embeddingModel',
	MaxFileSize = 'forge.indexer.maxFileSize',
	MaxProjectFiles = 'forge.indexer.maxProjectFiles',
}

export const enum ForgeContextSettingId {
	DefaultTokenBudget = 'forge.context.defaultTokenBudget',
	AlwaysInclude = 'forge.context.alwaysInclude',
}

export const enum ForgeDiffSettingId {
	AutoOpenOnChange = 'forge.diff.autoOpenOnChange',
	ShowGutterDecorations = 'forge.diff.showGutterDecorations',
	HighlightDuration = 'forge.diff.highlightDuration',
}

export const enum ForgeMemorySettingId {
	Enabled = 'forge.memory.enabled',
	MaxEntries = 'forge.memory.maxEntries',
	DecayDays = 'forge.memory.decayDays',
	AutoExtract = 'forge.memory.autoExtract',
}

export const enum ForgeGitHubSettingId {
	Enabled = 'forge.github.enabled',
	AutoLinkIssues = 'forge.github.autoLinkIssues',
	PrTemplate = 'forge.github.prTemplate',
	DefaultReviewers = 'forge.github.defaultReviewers',
	CiMonitoring = 'forge.github.ciMonitoring',
}

export const enum ForgeTaskSettingId {
	MaxConcurrent = 'forge.tasks.maxConcurrent',
	DailyTokenBudget = 'forge.tasks.dailyTokenBudget',
	PersistQueue = 'forge.tasks.persistQueue',
}

export const enum ForgePrivacySettingId {
	TelemetryEnabled = 'forge.telemetry.enabled',
	MemoryCloudSync = 'forge.memory.cloudSync',
}

// --- Types ---

export type ForgeConfirmationLevel = 'cautious' | 'balanced' | 'autonomous';
export type ForgeModelId = 'claude-opus' | 'claude-sonnet' | 'claude-haiku';
export type ForgeBackgroundAgentMode = 'active' | 'on-save' | 'on-commit' | 'off';

// --- Service Interface ---

export const IForgeConfigService = createDecorator<IForgeConfigService>('forgeConfigService');

export interface IForgeConfigService {
	readonly _serviceBrand: undefined;

	/** Fires when the API key changes. */
	readonly onDidChangeApiKey: Event<void>;

	/** Get the stored Anthropic API key. */
	getApiKey(): Promise<string | undefined>;

	/** Store the Anthropic API key securely. */
	setApiKey(key: string): Promise<void>;

	/** Remove the stored API key. */
	clearApiKey(): Promise<void>;

	/** Check if an API key is configured. */
	hasApiKey(): Promise<boolean>;

	/** Get a Forge setting value. */
	getSetting<T>(key: string): T | undefined;

	/** Get the configured default model. */
	getDefaultModel(): ForgeModelId;

	/** Get the configured complex task model. */
	getComplexTaskModel(): ForgeModelId;

	/** Get the configured background model. */
	getBackgroundModel(): ForgeModelId;

	/** Get the confirmation level. */
	getConfirmationLevel(): ForgeConfirmationLevel;

	/** Get max tokens per request. */
	getMaxTokensPerRequest(): number;

	/** Check if streaming is enabled. */
	isStreamingEnabled(): boolean;
}

// --- Service Implementation ---

export class ForgeConfigService extends Disposable implements IForgeConfigService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeApiKey = this._register(new Emitter<void>());
	readonly onDidChangeApiKey: Event<void> = this._onDidChangeApiKey.event;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(this.secretStorageService.onDidChangeSecret(key => {
			if (key === FORGE_API_KEY_SECRET) {
				this._onDidChangeApiKey.fire();
			}
		}));
	}

	async getApiKey(): Promise<string | undefined> {
		try {
			return await this.secretStorageService.get(FORGE_API_KEY_SECRET);
		} catch (e) {
			this.logService.error('[Forge] Failed to retrieve API key:', e);
			return undefined;
		}
	}

	async setApiKey(key: string): Promise<void> {
		await this.secretStorageService.set(FORGE_API_KEY_SECRET, key);
		this.logService.info('[Forge] API key stored successfully');
	}

	async clearApiKey(): Promise<void> {
		await this.secretStorageService.delete(FORGE_API_KEY_SECRET);
		this.logService.info('[Forge] API key cleared');
	}

	async hasApiKey(): Promise<boolean> {
		const key = await this.getApiKey();
		return key !== undefined && key.length > 0;
	}

	getSetting<T>(key: string): T | undefined {
		return this.configurationService.getValue<T>(key);
	}

	getDefaultModel(): ForgeModelId {
		return this.configurationService.getValue<ForgeModelId>(ForgeAgentSettingId.DefaultModel) ?? 'claude-sonnet';
	}

	getComplexTaskModel(): ForgeModelId {
		return this.configurationService.getValue<ForgeModelId>(ForgeAgentSettingId.ComplexTaskModel) ?? 'claude-opus';
	}

	getBackgroundModel(): ForgeModelId {
		return this.configurationService.getValue<ForgeModelId>(ForgeAgentSettingId.BackgroundModel) ?? 'claude-haiku';
	}

	getConfirmationLevel(): ForgeConfirmationLevel {
		return this.configurationService.getValue<ForgeConfirmationLevel>(ForgeAgentSettingId.ConfirmationLevel) ?? 'balanced';
	}

	getMaxTokensPerRequest(): number {
		return this.configurationService.getValue<number>(ForgeAgentSettingId.MaxTokensPerRequest) ?? 100000;
	}

	isStreamingEnabled(): boolean {
		return this.configurationService.getValue<boolean>(ForgeAgentSettingId.StreamResponses) ?? true;
	}
}

registerSingleton(IForgeConfigService, ForgeConfigService, InstantiationType.Delayed);
