/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from '../../vs/base/common/event.js';
import { Disposable, DisposableStore } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { ITextFileService } from '../../vs/workbench/services/textfile/common/textfiles.js';
import { IForgeAgentEngine } from './agent-engine.js';
import { IForgeTokenTracker } from './token-tracker.js';

// --- Types ---

export const enum SuggestionType {
	BugDetection = 'bug_detection',
	SecurityWarning = 'security_warning',
	PerformanceTip = 'performance_tip',
	CodeQuality = 'code_quality',
	TestSuggestion = 'test_suggestion',
	RefactorOpportunity = 'refactor_opportunity',
	DependencyAlert = 'dependency_alert',
	Documentation = 'documentation',
}

export const enum SuggestionCategory {
	Correctness = 'correctness',
	Security = 'security',
	Performance = 'performance',
	Maintainability = 'maintainability',
	Testing = 'testing',
}

export interface BackgroundSuggestion {
	readonly id: string;
	readonly type: SuggestionType;
	readonly severity: 'info' | 'warning' | 'critical';
	readonly title: string;
	readonly description: string;
	readonly filePath: string;
	readonly lineRange: { readonly start: number; readonly end: number };
	readonly suggestedFix?: {
		readonly description: string;
		readonly diff: string;
	};
	readonly category: SuggestionCategory;
	dismissed: boolean;
}

export const enum BackgroundAgentState {
	Idle = 'idle',
	Analyzing = 'analyzing',
	Paused = 'paused',
	Disabled = 'disabled',
}

// --- Service Interface ---

export const IForgeBackgroundAgent = createDecorator<IForgeBackgroundAgent>('forgeBackgroundAgent');

export interface IForgeBackgroundAgent {
	readonly _serviceBrand: undefined;

	readonly onDidChangeState: Event<BackgroundAgentState>;
	readonly onDidAddSuggestion: Event<BackgroundSuggestion>;
	readonly onDidRemoveSuggestion: Event<string>;

	readonly state: BackgroundAgentState;

	/** Start background monitoring. */
	start(): void;

	/** Pause monitoring. */
	pause(): void;

	/** Resume monitoring. */
	resume(): void;

	/** Trigger analysis for a specific file. */
	analyzeFile(filePath: string): Promise<void>;

	/** Get all active (non-dismissed) suggestions. */
	getSuggestions(): readonly BackgroundSuggestion[];

	/** Get suggestions for a specific file. */
	getFileSuggestions(filePath: string): readonly BackgroundSuggestion[];

	/** Dismiss a suggestion. */
	dismissSuggestion(id: string): void;

	/** Dismiss all suggestions. */
	dismissAll(): void;

	/** Get today's token usage for background analysis. */
	getTodayTokenUsage(): number;
}

// --- Service Implementation ---

export class ForgeBackgroundAgent extends Disposable implements IForgeBackgroundAgent {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<BackgroundAgentState>());
	readonly onDidChangeState: Event<BackgroundAgentState> = this._onDidChangeState.event;

	private readonly _onDidAddSuggestion = this._register(new Emitter<BackgroundSuggestion>());
	readonly onDidAddSuggestion: Event<BackgroundSuggestion> = this._onDidAddSuggestion.event;

	private readonly _onDidRemoveSuggestion = this._register(new Emitter<string>());
	readonly onDidRemoveSuggestion: Event<string> = this._onDidRemoveSuggestion.event;

	private _state: BackgroundAgentState = BackgroundAgentState.Disabled;
	private readonly _suggestions = new Map<string, BackgroundSuggestion>();
	private readonly _debounceTimers = this._register(new DisposableStore());
	private _todayTokenUsage = 0;

	get state(): BackgroundAgentState {
		return this._state;
	}

	constructor(
		@IForgeAgentEngine _agentEngine: IForgeAgentEngine,
		@IForgeTokenTracker _tokenTracker: IForgeTokenTracker,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		// Listen for file saves to trigger analysis
		this._register(this.textFileService.files.onDidSave(e => {
			if (this._state === BackgroundAgentState.Idle) {
				this._debounceAnalysis(e.model.resource.fsPath, 2000);
			}
		}));
	}

	start(): void {
		const enabled = this.configurationService.getValue<boolean>('forge.backgroundAgent.enabled') ?? true;
		if (!enabled) {
			this._setState(BackgroundAgentState.Disabled);
			return;
		}

		const mode = this.configurationService.getValue<string>('forge.backgroundAgent.mode') ?? 'on-save';
		if (mode === 'off') {
			this._setState(BackgroundAgentState.Disabled);
			return;
		}

		this._setState(BackgroundAgentState.Idle);
		this.logService.info(`[Forge] Background agent started in "${mode}" mode`);
	}

	pause(): void {
		if (this._state !== BackgroundAgentState.Disabled) {
			this._setState(BackgroundAgentState.Paused);
		}
	}

	resume(): void {
		if (this._state === BackgroundAgentState.Paused) {
			this._setState(BackgroundAgentState.Idle);
		}
	}

	async analyzeFile(filePath: string): Promise<void> {
		if (this._state === BackgroundAgentState.Paused || this._state === BackgroundAgentState.Disabled) {
			return;
		}

		const dailyBudget = this.configurationService.getValue<number>('forge.backgroundAgent.dailyTokenBudget') ?? 500000;
		if (this._todayTokenUsage >= dailyBudget) {
			this.logService.trace(`[Forge] Background agent daily budget exceeded (${this._todayTokenUsage}/${dailyBudget})`);
			return;
		}

		if (this._suggestions.size >= 20) {
			return;
		}

		this._setState(BackgroundAgentState.Analyzing);

		try {
			const suggestions = await this._runAnalysis(filePath);
			for (const suggestion of suggestions) {
				this._addSuggestion(suggestion);
			}
		} catch (e) {
			this.logService.warn(`[Forge] Background analysis failed for ${filePath}: ${e}`);
		} finally {
			this._setState(BackgroundAgentState.Idle);
		}
	}

	getSuggestions(): readonly BackgroundSuggestion[] {
		return [...this._suggestions.values()].filter(s => !s.dismissed);
	}

	getFileSuggestions(filePath: string): readonly BackgroundSuggestion[] {
		return this.getSuggestions().filter(s => s.filePath === filePath);
	}

	dismissSuggestion(id: string): void {
		const suggestion = this._suggestions.get(id);
		if (suggestion) {
			suggestion.dismissed = true;
			this._onDidRemoveSuggestion.fire(id);
		}
	}

	dismissAll(): void {
		for (const [id, suggestion] of this._suggestions) {
			if (!suggestion.dismissed) {
				suggestion.dismissed = true;
				this._onDidRemoveSuggestion.fire(id);
			}
		}
	}

	getTodayTokenUsage(): number {
		return this._todayTokenUsage;
	}

	private async _runAnalysis(_filePath: string): Promise<BackgroundSuggestion[]> {
		// Infrastructure ready — full implementation will call Claude Haiku via agentEngine
		// with a specialized system prompt for code analysis.
		return [];
	}

	private _addSuggestion(suggestion: BackgroundSuggestion): void {
		const fileSuggestions = this.getFileSuggestions(suggestion.filePath);
		if (fileSuggestions.length >= 5) {
			return;
		}

		const minSeverity = this.configurationService.getValue<string>('forge.backgroundAgent.minSeverity') ?? 'warning';
		if (!this._meetsSeverityThreshold(suggestion.severity, minSeverity)) {
			return;
		}

		this._suggestions.set(suggestion.id, suggestion);
		this._onDidAddSuggestion.fire(suggestion);
	}

	private _meetsSeverityThreshold(severity: string, minSeverity: string): boolean {
		const levels: Record<string, number> = { 'info': 0, 'warning': 1, 'critical': 2 };
		return (levels[severity] ?? 0) >= (levels[minSeverity] ?? 0);
	}

	private _debounceAnalysis(filePath: string, delayMs: number): void {
		const timer = setTimeout(() => this.analyzeFile(filePath), delayMs);
		this._debounceTimers.add({ dispose: () => clearTimeout(timer) });
	}

	private _setState(state: BackgroundAgentState): void {
		if (this._state !== state) {
			this._state = state;
			this._onDidChangeState.fire(state);
		}
	}
}

registerSingleton(IForgeBackgroundAgent, ForgeBackgroundAgent, InstantiationType.Delayed);
