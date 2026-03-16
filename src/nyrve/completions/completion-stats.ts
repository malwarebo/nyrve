/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { Emitter, Event } from '../../vs/base/common/event.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { INyrveCompletionCache } from './completion-cache.js';

// --- Types ---

export interface CompletionDaySummary {
	readonly date: string;
	readonly completionsShown: number;
	readonly completionsAccepted: number;
	readonly completionsDismissed: number;
	readonly completionsPartiallyAccepted: number;
	readonly acceptRate: number;
	readonly totalCharsInserted: number;
	readonly totalLatencyMs: number;
	readonly averageLatencyMs: number;
	readonly cacheHits: number;
	readonly cacheMisses: number;
	readonly cacheHitRate: number;
	readonly languageBreakdown: Record<string, LanguageCompletionStats>;
}

export interface LanguageCompletionStats {
	readonly shown: number;
	readonly accepted: number;
	readonly charsInserted: number;
}

export interface CompletionEvent {
	readonly type: 'shown' | 'accepted' | 'dismissed' | 'partial_accept';
	readonly language: string;
	readonly latencyMs: number;
	readonly charsInserted: number;
	readonly cached: boolean;
	readonly model: string;
	readonly timestamp: number;
}

// --- Service Interface ---

export const INyrveCompletionStats = createDecorator<INyrveCompletionStats>('nyrveCompletionStats');

export interface INyrveCompletionStats {
	readonly _serviceBrand: undefined;

	/** Fires when stats are updated. */
	readonly onDidUpdate: Event<void>;

	/** Record a completion event. */
	record(event: CompletionEvent): void;

	/** Get today's summary. */
	getTodaySummary(): CompletionDaySummary;

	/** Reset today's stats. */
	resetToday(): void;
}

// --- Implementation ---

export class NyrveCompletionStats extends Disposable implements INyrveCompletionStats {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidUpdate = this._register(new Emitter<void>());
	readonly onDidUpdate = this._onDidUpdate.event;

	private _events: CompletionEvent[] = [];
	private _currentDate: string = '';

	constructor(
		@INyrveCompletionCache private readonly cache: INyrveCompletionCache,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._currentDate = this._todayKey();
	}

	record(event: CompletionEvent): void {
		// Auto-reset on date change
		const today = this._todayKey();
		if (today !== this._currentDate) {
			this._events = [];
			this._currentDate = today;
		}

		this._events.push(event);
		this._onDidUpdate.fire();

		this.logService.trace(`[Nyrve] Completion stat: ${event.type} (${event.language}, ${event.latencyMs}ms, cached=${event.cached})`);
	}

	getTodaySummary(): CompletionDaySummary {
		const today = this._todayKey();
		if (today !== this._currentDate) {
			this._events = [];
			this._currentDate = today;
		}

		const shown = this._events.filter(e => e.type === 'shown');
		const accepted = this._events.filter(e => e.type === 'accepted');
		const dismissed = this._events.filter(e => e.type === 'dismissed');
		const partialAccepts = this._events.filter(e => e.type === 'partial_accept');

		const totalChars = accepted.reduce((sum, e) => sum + e.charsInserted, 0)
			+ partialAccepts.reduce((sum, e) => sum + e.charsInserted, 0);
		const totalLatency = shown.reduce((sum, e) => sum + e.latencyMs, 0);

		const cacheStats = this.cache.getStats();

		// Language breakdown
		const languageBreakdown: Record<string, LanguageCompletionStats> = {};
		for (const event of this._events) {
			if (!languageBreakdown[event.language]) {
				languageBreakdown[event.language] = { shown: 0, accepted: 0, charsInserted: 0 };
			}
			const lang = languageBreakdown[event.language];
			if (event.type === 'shown') {
				languageBreakdown[event.language] = { ...lang, shown: lang.shown + 1 };
			} else if (event.type === 'accepted') {
				languageBreakdown[event.language] = {
					...lang,
					accepted: lang.accepted + 1,
					charsInserted: lang.charsInserted + event.charsInserted,
				};
			}
		}

		return {
			date: today,
			completionsShown: shown.length,
			completionsAccepted: accepted.length,
			completionsDismissed: dismissed.length,
			completionsPartiallyAccepted: partialAccepts.length,
			acceptRate: shown.length > 0 ? accepted.length / shown.length : 0,
			totalCharsInserted: totalChars,
			totalLatencyMs: totalLatency,
			averageLatencyMs: shown.length > 0 ? totalLatency / shown.length : 0,
			cacheHits: cacheStats.hits,
			cacheMisses: cacheStats.misses,
			cacheHitRate: cacheStats.hitRate,
			languageBreakdown,
		};
	}

	resetToday(): void {
		this._events = [];
		this._currentDate = this._todayKey();
		this._onDidUpdate.fire();
	}

	private _todayKey(): string {
		return new Date().toISOString().slice(0, 10);
	}
}

registerSingleton(INyrveCompletionStats, NyrveCompletionStats, InstantiationType.Delayed);
