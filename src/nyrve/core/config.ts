/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
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

export const NYRVE_SCHEME = 'nyrve';
export const NYRVE_DATA_DIR = '.nyrve';
export const NYRVE_CONFIG_FILE = 'config.json';
export const NYRVE_SETTINGS_PREFIX = 'nyrve';
export const NYRVE_API_KEY_SECRET = 'nyrve.anthropic.apiKey';

// --- Settings Key Enums ---

export const enum NyrveAgentSettingId {
	ConfirmationLevel = 'nyrve.agent.confirmationLevel',
	DefaultModel = 'nyrve.agent.defaultModel',
	ComplexTaskModel = 'nyrve.agent.complexTaskModel',
	BackgroundModel = 'nyrve.agent.backgroundModel',
	ModelSwitcher = 'nyrve.agent.modelSwitcher',
	MaxTokensPerRequest = 'nyrve.agent.maxTokensPerRequest',
	StreamResponses = 'nyrve.agent.streamResponses',
}

export const enum NyrveBackgroundAgentSettingId {
	Enabled = 'nyrve.backgroundAgent.enabled',
	Mode = 'nyrve.backgroundAgent.mode',
	MinSeverity = 'nyrve.backgroundAgent.minSeverity',
	DailyTokenBudget = 'nyrve.backgroundAgent.dailyTokenBudget',
	DisabledCategories = 'nyrve.backgroundAgent.disabledCategories',
}

export const enum NyrveIndexerSettingId {
	Enabled = 'nyrve.indexer.enabled',
	EmbeddingModel = 'nyrve.indexer.embeddingModel',
	MaxFileSize = 'nyrve.indexer.maxFileSize',
	MaxProjectFiles = 'nyrve.indexer.maxProjectFiles',
}

export const enum NyrveContextSettingId {
	DefaultTokenBudget = 'nyrve.context.defaultTokenBudget',
	AlwaysInclude = 'nyrve.context.alwaysInclude',
}

export const enum NyrveDiffSettingId {
	AutoOpenOnChange = 'nyrve.diff.autoOpenOnChange',
	ShowGutterDecorations = 'nyrve.diff.showGutterDecorations',
	HighlightDuration = 'nyrve.diff.highlightDuration',
}

export const enum NyrveMemorySettingId {
	Enabled = 'nyrve.memory.enabled',
	MaxEntries = 'nyrve.memory.maxEntries',
	DecayDays = 'nyrve.memory.decayDays',
	AutoExtract = 'nyrve.memory.autoExtract',
}

export const enum NyrveGitHubSettingId {
	Enabled = 'nyrve.github.enabled',
	AutoLinkIssues = 'nyrve.github.autoLinkIssues',
	PrTemplate = 'nyrve.github.prTemplate',
	DefaultReviewers = 'nyrve.github.defaultReviewers',
	CiMonitoring = 'nyrve.github.ciMonitoring',
}

export const enum NyrveTaskSettingId {
	MaxConcurrent = 'nyrve.tasks.maxConcurrent',
	DailyTokenBudget = 'nyrve.tasks.dailyTokenBudget',
	PersistQueue = 'nyrve.tasks.persistQueue',
}

export const enum NyrvePrivacySettingId {
	TelemetryEnabled = 'nyrve.telemetry.enabled',
	MemoryCloudSync = 'nyrve.memory.cloudSync',
}

// --- Types ---

export type NyrveConfirmationLevel = 'cautious' | 'balanced' | 'autonomous';
export type NyrveModelId = 'claude-opus' | 'claude-sonnet' | 'claude-haiku';
export type NyrveBackgroundAgentMode = 'active' | 'on-save' | 'on-commit' | 'off';

// --- Service Interface ---

export const INyrveConfigService = createDecorator<INyrveConfigService>('nyrveConfigService');

export interface INyrveConfigService {
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

	/** Get a Nyrve setting value. */
	getSetting<T>(key: string): T | undefined;

	/** Get the configured default model. */
	getDefaultModel(): NyrveModelId;

	/** Get the configured complex task model. */
	getComplexTaskModel(): NyrveModelId;

	/** Get the configured background model. */
	getBackgroundModel(): NyrveModelId;

	/** Get the confirmation level. */
	getConfirmationLevel(): NyrveConfirmationLevel;

	/** Get max tokens per request. */
	getMaxTokensPerRequest(): number;

	/** Check if streaming is enabled. */
	isStreamingEnabled(): boolean;
}

// --- Service Implementation ---

export class NyrveConfigService extends Disposable implements INyrveConfigService {
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
			if (key === NYRVE_API_KEY_SECRET) {
				this._onDidChangeApiKey.fire();
			}
		}));
	}

	async getApiKey(): Promise<string | undefined> {
		try {
			return await this.secretStorageService.get(NYRVE_API_KEY_SECRET);
		} catch (e) {
			this.logService.error('[Nyrve] Failed to retrieve API key:', e);
			return undefined;
		}
	}

	async setApiKey(key: string): Promise<void> {
		await this.secretStorageService.set(NYRVE_API_KEY_SECRET, key);
		this.logService.info('[Nyrve] API key stored successfully');
	}

	async clearApiKey(): Promise<void> {
		await this.secretStorageService.delete(NYRVE_API_KEY_SECRET);
		this.logService.info('[Nyrve] API key cleared');
	}

	async hasApiKey(): Promise<boolean> {
		const key = await this.getApiKey();
		return key !== undefined && key.length > 0;
	}

	getSetting<T>(key: string): T | undefined {
		return this.configurationService.getValue<T>(key);
	}

	getDefaultModel(): NyrveModelId {
		return this.configurationService.getValue<NyrveModelId>(NyrveAgentSettingId.DefaultModel) ?? 'claude-sonnet';
	}

	getComplexTaskModel(): NyrveModelId {
		return this.configurationService.getValue<NyrveModelId>(NyrveAgentSettingId.ComplexTaskModel) ?? 'claude-opus';
	}

	getBackgroundModel(): NyrveModelId {
		return this.configurationService.getValue<NyrveModelId>(NyrveAgentSettingId.BackgroundModel) ?? 'claude-haiku';
	}

	getConfirmationLevel(): NyrveConfirmationLevel {
		return this.configurationService.getValue<NyrveConfirmationLevel>(NyrveAgentSettingId.ConfirmationLevel) ?? 'balanced';
	}

	getMaxTokensPerRequest(): number {
		return this.configurationService.getValue<number>(NyrveAgentSettingId.MaxTokensPerRequest) ?? 100000;
	}

	isStreamingEnabled(): boolean {
		return this.configurationService.getValue<boolean>(NyrveAgentSettingId.StreamResponses) ?? true;
	}
}

registerSingleton(INyrveConfigService, NyrveConfigService, InstantiationType.Delayed);
