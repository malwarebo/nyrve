/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from '../../vs/base/common/event.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';

// --- Types ---

export interface NyrveSettingChange {
	readonly key: string;
	readonly value: unknown;
}

// --- Service Interface ---

export const INyrveSettingsService = createDecorator<INyrveSettingsService>('nyrveSettingsService');

export interface INyrveSettingsService {
	readonly _serviceBrand: undefined;

	readonly onSettingChanged: Event<NyrveSettingChange>;

	// --- Models ---
	getDefaultModel(): string;
	getComplexTaskModel(): string;
	getBackgroundModel(): string;
	getShowModelSwitcher(): boolean;

	// --- Agent ---
	getConfirmationLevel(): 'cautious' | 'balanced' | 'autonomous';
	getMaxTokensPerRequest(): number;
	getStreamResponses(): boolean;

	// --- Features ---
	getBackgroundAgentEnabled(): boolean;
	getBackgroundAgentMode(): 'active' | 'on-save' | 'on-commit' | 'off';
	getIndexerEnabled(): boolean;
	getMemoryEnabled(): boolean;
	getGitHubEnabled(): boolean;
	getTaskQueueEnabled(): boolean;

	// --- Budgets ---
	getBackgroundAgentDailyBudget(): number;
	getTaskQueueDailyBudget(): number;

	// --- Context ---
	getContextTokenBudget(): number;

	// --- Privacy ---
	getTelemetryEnabled(): boolean;
	getMemoryCloudSync(): boolean;

	// --- GitHub ---
	getCIMonitoring(): boolean;

	// --- Diff ---
	getDiffAutoOpen(): boolean;
	getDiffShowGutter(): boolean;
	getDiffHighlightDuration(): number;

	// --- Memory ---
	getMemoryMaxEntries(): number;
	getMemoryDecayDays(): number;
	getMemoryAutoExtract(): boolean;

	// --- Generic ---
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Promise<void>;
}

// --- Service Implementation ---

/**
 * Typed wrapper around VS Code's IConfigurationService for all `nyrve.*` settings.
 * Provides strongly-typed getters with defaults and fires change events.
 * Global settings live in VS Code's settings system; per-project overrides
 * come from `.nyrve/config.json` (loaded separately by INyrveStorage).
 */
export class NyrveSettingsService extends Disposable implements INyrveSettingsService {
	declare readonly _serviceBrand: undefined;

	private readonly _onSettingChanged = this._register(new Emitter<NyrveSettingChange>());
	readonly onSettingChanged: Event<NyrveSettingChange> = this._onSettingChanged.event;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('nyrve')) {
				// Fire for each nyrve key that changed
				for (const key of e.affectedKeys) {
					if (key.startsWith('nyrve.')) {
						const value = this.configurationService.getValue(key);
						this._onSettingChanged.fire({ key, value });
					}
				}
			}
		}));
	}

	// --- Models ---

	getDefaultModel(): string {
		return this.configurationService.getValue<string>('nyrve.agent.defaultModel') ?? 'claude-sonnet';
	}

	getComplexTaskModel(): string {
		return this.configurationService.getValue<string>('nyrve.agent.complexTaskModel') ?? 'claude-opus';
	}

	getBackgroundModel(): string {
		return this.configurationService.getValue<string>('nyrve.agent.backgroundModel') ?? 'claude-haiku';
	}

	getShowModelSwitcher(): boolean {
		return this.configurationService.getValue<boolean>('nyrve.agent.modelSwitcher') ?? true;
	}

	// --- Agent ---

	getConfirmationLevel(): 'cautious' | 'balanced' | 'autonomous' {
		return this.configurationService.getValue<'cautious' | 'balanced' | 'autonomous'>('nyrve.agent.confirmationLevel') ?? 'balanced';
	}

	getMaxTokensPerRequest(): number {
		return this.configurationService.getValue<number>('nyrve.agent.maxTokensPerRequest') ?? 100000;
	}

	getStreamResponses(): boolean {
		return this.configurationService.getValue<boolean>('nyrve.agent.streamResponses') ?? true;
	}

	// --- Features ---

	getBackgroundAgentEnabled(): boolean {
		return this.configurationService.getValue<boolean>('nyrve.backgroundAgent.enabled') ?? true;
	}

	getBackgroundAgentMode(): 'active' | 'on-save' | 'on-commit' | 'off' {
		return this.configurationService.getValue<'active' | 'on-save' | 'on-commit' | 'off'>('nyrve.backgroundAgent.mode') ?? 'on-save';
	}

	getIndexerEnabled(): boolean {
		return this.configurationService.getValue<boolean>('nyrve.indexer.enabled') ?? true;
	}

	getMemoryEnabled(): boolean {
		return this.configurationService.getValue<boolean>('nyrve.memory.enabled') ?? true;
	}

	getGitHubEnabled(): boolean {
		return this.configurationService.getValue<boolean>('nyrve.github.enabled') ?? true;
	}

	getTaskQueueEnabled(): boolean {
		return this.configurationService.getValue<boolean>('nyrve.tasks.persistQueue') ?? true;
	}

	// --- Budgets ---

	getBackgroundAgentDailyBudget(): number {
		return this.configurationService.getValue<number>('nyrve.backgroundAgent.dailyTokenBudget') ?? 500000;
	}

	getTaskQueueDailyBudget(): number {
		return this.configurationService.getValue<number>('nyrve.tasks.dailyTokenBudget') ?? 1000000;
	}

	// --- Context ---

	getContextTokenBudget(): number {
		return this.configurationService.getValue<number>('nyrve.context.defaultTokenBudget') ?? 30000;
	}

	// --- Privacy ---

	getTelemetryEnabled(): boolean {
		return this.configurationService.getValue<boolean>('nyrve.telemetry.enabled') ?? false;
	}

	getMemoryCloudSync(): boolean {
		return this.configurationService.getValue<boolean>('nyrve.memory.cloudSync') ?? false;
	}

	// --- GitHub ---

	getCIMonitoring(): boolean {
		return this.configurationService.getValue<boolean>('nyrve.github.ciMonitoring') ?? true;
	}

	// --- Diff ---

	getDiffAutoOpen(): boolean {
		return this.configurationService.getValue<boolean>('nyrve.diff.autoOpenOnChange') ?? true;
	}

	getDiffShowGutter(): boolean {
		return this.configurationService.getValue<boolean>('nyrve.diff.showGutterDecorations') ?? true;
	}

	getDiffHighlightDuration(): number {
		return this.configurationService.getValue<number>('nyrve.diff.highlightDuration') ?? 30;
	}

	// --- Memory ---

	getMemoryMaxEntries(): number {
		return this.configurationService.getValue<number>('nyrve.memory.maxEntries') ?? 1000;
	}

	getMemoryDecayDays(): number {
		return this.configurationService.getValue<number>('nyrve.memory.decayDays') ?? 90;
	}

	getMemoryAutoExtract(): boolean {
		return this.configurationService.getValue<boolean>('nyrve.memory.autoExtract') ?? true;
	}

	// --- Generic ---

	get<T>(key: string): T | undefined {
		return this.configurationService.getValue<T>(key);
	}

	async update(key: string, value: unknown): Promise<void> {
		await this.configurationService.updateValue(key, value);
		this.logService.trace(`[Nyrve] Setting updated: ${key}`);
	}
}

registerSingleton(INyrveSettingsService, NyrveSettingsService, InstantiationType.Delayed);
