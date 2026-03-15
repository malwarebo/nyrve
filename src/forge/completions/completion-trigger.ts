/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { IForgeAgentService, ForgeAgentState } from '../agent/agent-service.js';

// --- Types ---

export type TriggerKind = 'typing' | 'explicit' | 'line_start';

export interface TriggerDecision {
	readonly trigger: boolean;
	readonly kind: TriggerKind;
	readonly delay: number;
	readonly reason?: string;
}

export interface EditorChangeEvent {
	/** The character(s) just typed, or empty for explicit trigger. */
	readonly text: string;
	/** Whether this is an explicit invocation (Cmd+Space). */
	readonly isExplicit: boolean;
	/** Current cursor line number (1-based). */
	readonly lineNumber: number;
	/** Current cursor column (1-based). */
	readonly column: number;
	/** Full text of the current line (before the edit). */
	readonly lineText: string;
	/** Whether text is currently selected. */
	readonly hasSelection: boolean;
	/** Language id of the current file. */
	readonly languageId: string;
	/** Total lines in the file. */
	readonly totalLines: number;
	/** Whether the cursor is inside a string literal. */
	readonly isInsideString: boolean;
	/** Whether the cursor is inside a comment. */
	readonly isInsideComment: boolean;
}

// --- Service Interface ---

export const IForgeCompletionTrigger = createDecorator<IForgeCompletionTrigger>('forgeCompletionTrigger');

export interface IForgeCompletionTrigger {
	readonly _serviceBrand: undefined;

	/** Evaluate whether a completion should trigger for the given editor event. */
	shouldTrigger(event: EditorChangeEvent): TriggerDecision;

	/** Record that a completion was accepted (starts cooldown). */
	recordAccept(): void;

	/** Record that a completion was dismissed via Escape (starts suppression). */
	recordDismiss(): void;

	/** Record that the API rate limit was hit. */
	recordRateLimit(): void;

	/** Clear the rate limit flag. */
	clearRateLimit(): void;
}

// --- Constants ---

const NO_TRIGGER = (reason: string): TriggerDecision => ({ trigger: false, kind: 'typing', delay: 0, reason });
const WORD_BOUNDARY = /\b$/;
const WHITESPACE = /\s/;

// --- Service Implementation ---

export class ForgeCompletionTrigger extends Disposable implements IForgeCompletionTrigger {
	declare readonly _serviceBrand: undefined;

	private _lastAcceptTime = 0;
	private _lastDismissTime = 0;
	private _rateLimited = false;

	constructor(
		@IForgeAgentService private readonly agentService: IForgeAgentService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	shouldTrigger(event: EditorChangeEvent): TriggerDecision {
		// Check if completions are enabled
		const enabled = this.configurationService.getValue<boolean>('forge.completions.enabled') ?? true;
		if (!enabled) {
			return NO_TRIGGER('completions disabled');
		}

		// Check language enable/disable lists
		if (!this._isLanguageEnabled(event.languageId)) {
			return NO_TRIGGER('language disabled');
		}

		// Explicit trigger (Cmd+Space) — always fires immediately
		if (event.isExplicit) {
			return { trigger: true, kind: 'explicit', delay: 0 };
		}

		// Rate limit backoff
		if (this._rateLimited) {
			return NO_TRIGGER('rate limited');
		}

		// Don't trigger during text selection
		if (event.hasSelection) {
			return NO_TRIGGER('text selected');
		}

		// Don't trigger while agent panel is generating
		const agentState = this.agentService.state;
		if (agentState === ForgeAgentState.Thinking || agentState === ForgeAgentState.Streaming) {
			return NO_TRIGGER('agent generating');
		}

		// Cooldown after accepting a completion (500ms)
		const now = Date.now();
		if (now - this._lastAcceptTime < 500) {
			return NO_TRIGGER('accept cooldown');
		}

		// Suppression after Escape (2s)
		if (now - this._lastDismissTime < 2000) {
			return NO_TRIGGER('dismiss suppression');
		}

		// Get configured base delay
		const baseDelay = this.configurationService.getValue<number>('forge.completions.triggerDelay') ?? 150;

		// Empty line with cursor at start — fast trigger
		const trimmedLine = event.lineText.trim();
		if (trimmedLine.length === 0 && event.column <= 1) {
			return { trigger: true, kind: 'line_start', delay: 50 };
		}

		// Enter key (new line)
		if (event.text === '\n' || event.text === '\r\n') {
			return { trigger: true, kind: 'line_start', delay: 100 };
		}

		// Whitespace after statement — likely starting new expression
		if (event.text.length === 1 && WHITESPACE.test(event.text)) {
			return { trigger: true, kind: 'typing', delay: 100 };
		}

		// Inside string or comment — longer delay
		if (event.isInsideString || event.isInsideComment) {
			return { trigger: true, kind: 'typing', delay: 200 };
		}

		// In the middle of a word — wait for word boundary
		if (event.text.length === 1 && /\w/.test(event.text)) {
			const textBeforeCursor = event.lineText.slice(0, event.column - 1) + event.text;
			if (!WORD_BOUNDARY.test(textBeforeCursor)) {
				// Still typing a word — trigger with standard delay (debounce will handle it)
				return { trigger: true, kind: 'typing', delay: baseDelay };
			}
		}

		// Large files get longer delay
		if (event.totalLines > 10000) {
			return { trigger: true, kind: 'typing', delay: 300 };
		}

		// Default: trigger with configured delay
		return { trigger: true, kind: 'typing', delay: baseDelay };
	}

	recordAccept(): void {
		this._lastAcceptTime = Date.now();
	}

	recordDismiss(): void {
		this._lastDismissTime = Date.now();
	}

	recordRateLimit(): void {
		this._rateLimited = true;
		this.logService.info('[Forge] Completions: rate limit hit, backing off');
	}

	clearRateLimit(): void {
		this._rateLimited = false;
	}

	private _isLanguageEnabled(languageId: string): boolean {
		const enabledLanguages = this.configurationService.getValue<string[]>('forge.completions.enabledLanguages') ?? ['*'];
		const disabledLanguages = this.configurationService.getValue<string[]>('forge.completions.disabledLanguages') ?? [];

		if (disabledLanguages.includes(languageId)) {
			return false;
		}

		if (enabledLanguages.includes('*')) {
			return true;
		}

		return enabledLanguages.includes(languageId);
	}
}

registerSingleton(IForgeCompletionTrigger, ForgeCompletionTrigger, InstantiationType.Delayed);
