/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../vs/base/common/lifecycle.js';
import { Emitter, Event } from '../../vs/base/common/event.js';
import { CancellationToken } from '../../vs/base/common/cancellation.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { IContextKeyService, IContextKey } from '../../vs/platform/contextkey/common/contextkey.js';
import { ILanguageFeaturesService } from '../../vs/editor/common/services/languageFeatures.js';
import { Position } from '../../vs/editor/common/core/position.js';
import { Range } from '../../vs/editor/common/core/range.js';
import {
	InlineCompletions,
	InlineCompletionsProvider,
	InlineCompletionContext,
	InlineCompletionTriggerKind,
	InlineCompletionsDisposeReason,
	IInlineCompletionChangeHint,
} from '../../vs/editor/common/languages.js';
import { ITextModel } from '../../vs/editor/common/model.js';
import { INyrveCompletionEngine, CompletionResult } from './completion-engine.js';
import { INyrveCompletionPostProcessor } from './completion-postprocessor.js';
import { INyrveCompletionTrigger, TriggerKind, TriggerDecision, EditorChangeEvent } from './completion-trigger.js';
import { RawContextKey } from '../../vs/platform/contextkey/common/contextkey.js';

// --- Types ---

export interface GhostTextState {
	readonly visible: boolean;
	readonly text: string;
	readonly lineCount: number;
	readonly previewText: string;
}

// --- Service Interface ---

export const INyrveGhostTextRenderer = createDecorator<INyrveGhostTextRenderer>('nyrveGhostTextRenderer');

export interface INyrveGhostTextRenderer {
	readonly _serviceBrand: undefined;

	/** Current ghost text state. */
	readonly state: GhostTextState;

	/** Fires when ghost text state changes. */
	readonly onDidChangeState: Event<GhostTextState>;

	/** Accept the currently shown ghost text (full). */
	accept(): boolean;

	/** Accept one word of the ghost text. */
	acceptWord(): boolean;

	/** Accept one line of the ghost text. */
	acceptLine(): boolean;

	/** Dismiss the current ghost text. */
	dismiss(): void;

	/** Cycle to next completion (if multiple available). */
	next(): void;

	/** Cycle to previous completion. */
	previous(): void;
}

// --- Context Keys ---

export const NyrveCompletionVisibleContext = new RawContextKey<boolean>('nyrveCompletionVisible', false);

// --- Constants ---

const MAX_PREVIEW_LINES = 3;

// --- Implementation ---

export class NyrveGhostTextRenderer extends Disposable implements INyrveGhostTextRenderer, InlineCompletionsProvider {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<GhostTextState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly _onDidChangeInlineCompletions = this._register(new Emitter<IInlineCompletionChangeHint>());
	readonly onDidChangeInlineCompletions = this._onDidChangeInlineCompletions.event;

	private _currentResult: CompletionResult | undefined;
	private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly _providerRegistration = this._register(new MutableDisposable());
	private readonly _completionVisibleKey: IContextKey<boolean>;

	private _state: GhostTextState = { visible: false, text: '', lineCount: 0, previewText: '' };

	get state(): GhostTextState {
		return this._state;
	}

	constructor(
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@INyrveCompletionEngine private readonly completionEngine: INyrveCompletionEngine,
		@INyrveCompletionPostProcessor private readonly postProcessor: INyrveCompletionPostProcessor,
		@INyrveCompletionTrigger private readonly trigger: INyrveCompletionTrigger,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._completionVisibleKey = NyrveCompletionVisibleContext.bindTo(contextKeyService);
		this._registerProvider();
	}

	private _registerProvider(): void {
		// Register as an inline completions provider for all languages
		this._providerRegistration.value = this.languageFeaturesService.inlineCompletionsProvider.register(
			{ pattern: '**' },
			this,
		);
	}

	// --- InlineCompletionsProvider implementation ---

	async provideInlineCompletions(
		model: ITextModel,
		position: Position,
		context: InlineCompletionContext,
		token: CancellationToken,
	): Promise<InlineCompletions | undefined> {
		const enabled = this.configurationService.getValue<boolean>('nyrve.completions.enabled') ?? true;
		if (!enabled) {
			return undefined;
		}

		// Map VS Code trigger kind to Nyrve trigger kind
		const triggerKind: TriggerKind = context.triggerKind === InlineCompletionTriggerKind.Explicit
			? 'explicit'
			: 'typing';

		// Build a trigger event from current state
		const lineText = model.getLineContent(position.lineNumber);
		const event: EditorChangeEvent = {
			text: '',
			isExplicit: triggerKind === 'explicit',
			lineNumber: position.lineNumber,
			column: position.column,
			lineText,
			hasSelection: false,
			languageId: model.getLanguageId(),
			totalLines: model.getLineCount(),
			isInsideString: false,
			isInsideComment: false,
		};

		// Check trigger rules
		const decision: TriggerDecision = this.trigger.shouldTrigger(event);
		if (!decision.trigger) {
			this.logService.trace(`[Nyrve] Completion skipped: ${decision.reason}`);
			return undefined;
		}

		// Apply debounce via delay
		if (decision.delay > 0 && triggerKind !== 'explicit') {
			await this._delay(decision.delay, token);
			if (token.isCancellationRequested) {
				return undefined;
			}
		}

		// Request completion from engine
		const result = await this.completionEngine.complete(triggerKind);
		if (!result || token.isCancellationRequested) {
			this._updateState({ visible: false, text: '', lineCount: 0, previewText: '' });
			return undefined;
		}

		// Post-process the completion
		const request = {
			filePath: model.uri.fsPath,
			language: model.getLanguageId(),
			fileContent: model.getValue(),
			cursorLine: position.lineNumber,
			cursorColumn: position.column,
			prefix: lineText.slice(0, position.column - 1),
			suffix: lineText.slice(position.column - 1),
			linesBefore: [],
			linesAfter: [],
			openTabs: [],
			recentEdits: [],
			imports: [],
			conventions: [],
			patterns: [],
			triggerKind,
			requestId: result.requestId,
		};

		const processed = this.postProcessor.process(result.text, request);
		if (processed.text.length === 0) {
			this._updateState({ visible: false, text: '', lineCount: 0, previewText: '' });
			return undefined;
		}

		this._currentResult = { ...result, text: processed.text };


		const lines = processed.text.split('\n');
		const previewText = this._buildPreview(lines);

		this._updateState({
			visible: true,
			text: processed.text,
			lineCount: lines.length,
			previewText,
		});

		// Build the inline completion item
		const insertRange = new Range(
			position.lineNumber,
			position.column,
			position.lineNumber,
			position.column,
		);

		return {
			items: [{
				insertText: processed.text,
				range: insertRange,
			}],
		};
	}

	handleItemDidShow?(): void {
		// Ghost text is now visible
	}

	handlePartialAccept?(): void {
		// Partial accept (word-by-word)
	}

	disposeInlineCompletions(_completions: InlineCompletions, _reason: InlineCompletionsDisposeReason): void {
		// Cleanup — nothing to dispose per-request
	}

	// --- Public API ---

	accept(): boolean {
		if (!this._state.visible || !this._currentResult) {
			return false;
		}
		this.trigger.recordAccept();
		this._clear();
		return true;
	}

	acceptWord(): boolean {
		if (!this._state.visible || !this._currentResult) {
			return false;
		}

		const text = this._currentResult.text;
		// Find the first word boundary
		const match = text.match(/^(\S+\s?|\s+\S+\s?)/);
		if (!match) {
			return this.accept();
		}

		// Remaining text becomes the new ghost text
		const remaining = text.slice(match[0].length);
		if (remaining.length === 0) {
			return this.accept();
		}

		this._currentResult = { ...this._currentResult, text: remaining };
		const lines = remaining.split('\n');
		this._updateState({
			visible: true,
			text: remaining,
			lineCount: lines.length,
			previewText: this._buildPreview(lines),
		});

		return true;
	}

	acceptLine(): boolean {
		if (!this._state.visible || !this._currentResult) {
			return false;
		}

		const text = this._currentResult.text;
		const newlineIdx = text.indexOf('\n');
		if (newlineIdx === -1) {
			return this.accept();
		}

		const remaining = text.slice(newlineIdx + 1);
		if (remaining.length === 0) {
			return this.accept();
		}

		this._currentResult = { ...this._currentResult, text: remaining };
		const lines = remaining.split('\n');
		this._updateState({
			visible: true,
			text: remaining,
			lineCount: lines.length,
			previewText: this._buildPreview(lines),
		});

		return true;
	}

	dismiss(): void {
		if (this._state.visible) {
			this.trigger.recordDismiss();
		}
		this._clear();
	}

	next(): void {
		// Currently only single completion — no cycling
	}

	previous(): void {
		// Currently only single completion — no cycling
	}

	// --- Private ---

	private _buildPreview(lines: string[]): string {
		if (lines.length <= MAX_PREVIEW_LINES) {
			return lines.join('\n');
		}
		const preview = lines.slice(0, MAX_PREVIEW_LINES).join('\n');
		const remaining = lines.length - MAX_PREVIEW_LINES;
		return `${preview}\n\u22ef +${remaining} lines`;
	}

	private _updateState(state: GhostTextState): void {
		this._state = state;
		this._completionVisibleKey.set(state.visible);
		this._onDidChangeState.fire(state);
	}

	private _clear(): void {
		this._currentResult = undefined;

		this.completionEngine.cancel();
		if (this._debounceTimer !== undefined) {
			clearTimeout(this._debounceTimer);
			this._debounceTimer = undefined;
		}
		this._updateState({ visible: false, text: '', lineCount: 0, previewText: '' });
	}

	private _delay(ms: number, token: CancellationToken): Promise<void> {
		return new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, ms);
			token.onCancellationRequested(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	override dispose(): void {
		this._clear();
		super.dispose();
	}
}

registerSingleton(INyrveGhostTextRenderer, NyrveGhostTextRenderer, InstantiationType.Delayed);
