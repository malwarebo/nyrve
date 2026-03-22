/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from "../../vs/base/common/cancellation.js";
import { Event, Emitter } from "../../vs/base/common/event.js";
import { Disposable, DisposableStore } from "../../vs/base/common/lifecycle.js";
import { URI } from "../../vs/base/common/uri.js";
import { createDecorator } from "../../vs/platform/instantiation/common/instantiation.js";
import {
	InstantiationType,
	registerSingleton,
} from "../../vs/platform/instantiation/common/extensions.js";
import { IConfigurationService } from "../../vs/platform/configuration/common/configuration.js";
import { ILogService } from "../../vs/platform/log/common/log.js";
import { ITextFileService } from "../../vs/workbench/services/textfile/common/textfiles.js";
import { INyrveAgentEngine } from "./agent-engine.js";
import { INyrveModelRouter } from "./model-router.js";
import { INyrveTokenTracker } from "./token-tracker.js";

// --- Types ---

export const enum SuggestionType {
	BugDetection = "bug_detection",
	SecurityWarning = "security_warning",
	PerformanceTip = "performance_tip",
	CodeQuality = "code_quality",
	TestSuggestion = "test_suggestion",
	RefactorOpportunity = "refactor_opportunity",
	DependencyAlert = "dependency_alert",
	Documentation = "documentation",
}

export const enum SuggestionCategory {
	Correctness = "correctness",
	Security = "security",
	Performance = "performance",
	Maintainability = "maintainability",
	Testing = "testing",
}

export interface BackgroundSuggestion {
	readonly id: string;
	readonly type: SuggestionType;
	readonly severity: "info" | "warning" | "critical";
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
	Idle = "idle",
	Analyzing = "analyzing",
	Paused = "paused",
	Disabled = "disabled",
}

// --- Service Interface ---

export const INyrveBackgroundAgent = createDecorator<INyrveBackgroundAgent>(
	"nyrveBackgroundAgent",
);

export interface INyrveBackgroundAgent {
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

export class NyrveBackgroundAgent
	extends Disposable
	implements INyrveBackgroundAgent {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(
		new Emitter<BackgroundAgentState>(),
	);
	readonly onDidChangeState: Event<BackgroundAgentState> =
		this._onDidChangeState.event;

	private readonly _onDidAddSuggestion = this._register(
		new Emitter<BackgroundSuggestion>(),
	);
	readonly onDidAddSuggestion: Event<BackgroundSuggestion> =
		this._onDidAddSuggestion.event;

	private readonly _onDidRemoveSuggestion = this._register(
		new Emitter<string>(),
	);
	readonly onDidRemoveSuggestion: Event<string> =
		this._onDidRemoveSuggestion.event;

	private _state: BackgroundAgentState = BackgroundAgentState.Disabled;
	private readonly _suggestions = new Map<string, BackgroundSuggestion>();
	private readonly _debounceTimers = this._register(new DisposableStore());
	private _todayTokenUsage = 0;

	get state(): BackgroundAgentState {
		return this._state;
	}

	constructor(
		@INyrveAgentEngine private readonly agentEngine: INyrveAgentEngine,
		@INyrveModelRouter private readonly modelRouter: INyrveModelRouter,
		@INyrveTokenTracker private readonly tokenTracker: INyrveTokenTracker,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IConfigurationService
		private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		// Listen for file saves to trigger analysis
		this._register(
			this.textFileService.files.onDidSave((e) => {
				if (this._state === BackgroundAgentState.Idle) {
					this._debounceAnalysis(e.model.resource.fsPath, 2000);
				}
			}),
		);
	}

	start(): void {
		const enabled =
			this.configurationService.getValue<boolean>(
				"nyrve.backgroundAgent.enabled",
			) ?? true;
		if (!enabled) {
			this._setState(BackgroundAgentState.Disabled);
			return;
		}

		const mode =
			this.configurationService.getValue<string>(
				"nyrve.backgroundAgent.mode",
			) ?? "on-save";
		if (mode === "off") {
			this._setState(BackgroundAgentState.Disabled);
			return;
		}

		this._setState(BackgroundAgentState.Idle);
		this.logService.info(`[Nyrve] Background agent started in "${mode}" mode`);
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
		if (
			this._state === BackgroundAgentState.Paused ||
			this._state === BackgroundAgentState.Disabled
		) {
			return;
		}

		const dailyBudget =
			this.configurationService.getValue<number>(
				"nyrve.backgroundAgent.dailyTokenBudget",
			) ?? 500000;
		if (this._todayTokenUsage >= dailyBudget) {
			this.logService.trace(
				`[Nyrve] Background agent daily budget exceeded (${this._todayTokenUsage}/${dailyBudget})`,
			);
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
			this.logService.warn(
				`[Nyrve] Background analysis failed for ${filePath}: ${e}`,
			);
		} finally {
			this._setState(BackgroundAgentState.Idle);
		}
	}

	getSuggestions(): readonly BackgroundSuggestion[] {
		return [...this._suggestions.values()].filter((s) => !s.dismissed);
	}

	getFileSuggestions(filePath: string): readonly BackgroundSuggestion[] {
		return this.getSuggestions().filter((s) => s.filePath === filePath);
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

	private async _runAnalysis(
		filePath: string,
	): Promise<BackgroundSuggestion[]> {
		const uri = URI.file(filePath);
		let fileContent: string;
		try {
			const file = await this.textFileService.read(uri);
			fileContent = file.value;
		} catch {
			return [];
		}

		if (!fileContent.trim() || fileContent.length > 50_000) {
			return [];
		}

		const cts = new CancellationTokenSource();
		const timer = setTimeout(() => cts.cancel(), 30_000);

		try {
			const model = this.modelRouter.getBackgroundModel();
			const response = await this.agentEngine.sendMessage(
				{
					messages: [
						{ role: "user", content: fileContent, timestamp: Date.now() },
					],
					model,
					systemPrompt: [
						"You are a background code analyzer. Analyze the given file for bugs, security issues, performance problems, and code quality concerns.",
						'Respond ONLY with a JSON array of objects. Each object must have: "type" (one of: bug_detection, security_warning, performance_tip, code_quality, test_suggestion, refactor_opportunity), "severity" (info, warning, or critical), "title" (short summary), "description" (explanation), "startLine" (1-based), "endLine" (1-based).',
						"If there are no issues, respond with an empty array: []",
						"Do not include markdown fences or any text outside the JSON array.",
					].join(" "),
					maxTokens: 2048,
				},
				cts.token,
			);

			this._todayTokenUsage += response.inputTokens + response.outputTokens;
			this.tokenTracker.recordUsage(
				model,
				response.inputTokens,
				response.outputTokens,
			);

			return this._parseSuggestions(response.content, filePath);
		} catch (e) {
			this.logService.trace(
				`[Nyrve] Background analysis API call failed for ${filePath}: ${e}`,
			);
			return [];
		} finally {
			clearTimeout(timer);
			cts.dispose();
		}
	}

	private _parseSuggestions(
		responseContent: string,
		filePath: string,
	): BackgroundSuggestion[] {
		try {
			const parsed = JSON.parse(responseContent.trim());
			if (!Array.isArray(parsed)) {
				return [];
			}

			const TYPE_TO_CATEGORY: Record<string, SuggestionCategory> = {
				bug_detection: SuggestionCategory.Correctness,
				security_warning: SuggestionCategory.Security,
				performance_tip: SuggestionCategory.Performance,
				code_quality: SuggestionCategory.Maintainability,
				test_suggestion: SuggestionCategory.Testing,
				refactor_opportunity: SuggestionCategory.Maintainability,
			};

			const VALID_TYPES = new Set([
				"bug_detection",
				"security_warning",
				"performance_tip",
				"code_quality",
				"test_suggestion",
				"refactor_opportunity",
				"dependency_alert",
				"documentation",
			]);
			const VALID_SEVERITIES = new Set(["info", "warning", "critical"]);

			return parsed
				.filter(
					(item: Record<string, unknown>) =>
						typeof item.type === "string" &&
						VALID_TYPES.has(item.type as SuggestionType) &&
						typeof item.severity === "string" &&
						VALID_SEVERITIES.has(item.severity) &&
						typeof item.title === "string" &&
						typeof item.description === "string" &&
						typeof item.startLine === "number" &&
						typeof item.endLine === "number",
				)
				.map(
					(item: Record<string, unknown>): BackgroundSuggestion => ({
						id: `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
						type: item.type as SuggestionType,
						severity: item.severity as "info" | "warning" | "critical",
						title: item.title as string,
						description: item.description as string,
						filePath,
						lineRange: {
							start: item.startLine as number,
							end: item.endLine as number,
						},
						category:
							TYPE_TO_CATEGORY[item.type as string] ??
							SuggestionCategory.Maintainability,
						dismissed: false,
					}),
				);
		} catch {
			this.logService.trace(
				`[Nyrve] Failed to parse background analysis response`,
			);
			return [];
		}
	}

	private _addSuggestion(suggestion: BackgroundSuggestion): void {
		const fileSuggestions = this.getFileSuggestions(suggestion.filePath);
		if (fileSuggestions.length >= 5) {
			return;
		}

		const minSeverity =
			this.configurationService.getValue<string>(
				"nyrve.backgroundAgent.minSeverity",
			) ?? "warning";
		if (!this._meetsSeverityThreshold(suggestion.severity, minSeverity)) {
			return;
		}

		this._suggestions.set(suggestion.id, suggestion);
		this._onDidAddSuggestion.fire(suggestion);
	}

	private _meetsSeverityThreshold(
		severity: string,
		minSeverity: string,
	): boolean {
		const levels: Record<string, number> = { info: 0, warning: 1, critical: 2 };
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

registerSingleton(
	INyrveBackgroundAgent,
	NyrveBackgroundAgent,
	InstantiationType.Delayed,
);
