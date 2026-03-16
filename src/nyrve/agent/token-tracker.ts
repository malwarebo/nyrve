/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from '../../vs/base/common/event.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { NyrveModelId } from '../core/config.js';

// --- Cost per million tokens (USD) ---

const MODEL_COSTS: Record<NyrveModelId, { input: number; output: number }> = {
	'claude-opus': { input: 15.0, output: 75.0 },
	'claude-sonnet': { input: 3.0, output: 15.0 },
	'claude-haiku': { input: 0.25, output: 1.25 },
};

// --- Types ---

export interface TokenUsageRecord {
	readonly timestamp: number;
	readonly model: NyrveModelId;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly costUsd: number;
}

export interface TokenUsageSummary {
	readonly totalInputTokens: number;
	readonly totalOutputTokens: number;
	readonly totalCostUsd: number;
	readonly recordCount: number;
	readonly byModel: Record<NyrveModelId, { inputTokens: number; outputTokens: number; costUsd: number }>;
}

// --- Service Interface ---

export const INyrveTokenTracker = createDecorator<INyrveTokenTracker>('nyrveTokenTracker');

export interface INyrveTokenTracker {
	readonly _serviceBrand: undefined;

	/** Fires when token usage is recorded. */
	readonly onDidRecordUsage: Event<TokenUsageRecord>;

	/** Record token usage for an API call. */
	recordUsage(model: NyrveModelId, inputTokens: number, outputTokens: number): TokenUsageRecord;

	/** Get token usage summary for today. */
	getTodaySummary(): TokenUsageSummary;

	/** Get token usage summary for a date range. */
	getSummary(since: number): TokenUsageSummary;

	/** Get all records for today. */
	getTodayRecords(): readonly TokenUsageRecord[];

	/** Calculate cost for a given model and token count. */
	calculateCost(model: NyrveModelId, inputTokens: number, outputTokens: number): number;

	/** Reset today's tracking data. */
	resetToday(): void;
}

// --- Service Implementation ---

export class NyrveTokenTracker extends Disposable implements INyrveTokenTracker {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidRecordUsage = this._register(new Emitter<TokenUsageRecord>());
	readonly onDidRecordUsage: Event<TokenUsageRecord> = this._onDidRecordUsage.event;

	private readonly records: TokenUsageRecord[] = [];

	constructor(
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	recordUsage(model: NyrveModelId, inputTokens: number, outputTokens: number): TokenUsageRecord {
		const costUsd = this.calculateCost(model, inputTokens, outputTokens);
		const record: TokenUsageRecord = {
			timestamp: Date.now(),
			model,
			inputTokens,
			outputTokens,
			costUsd,
		};

		this.records.push(record);
		this.logService.trace(`[Nyrve] Token usage: ${model} in=${inputTokens} out=${outputTokens} cost=$${costUsd.toFixed(4)}`);
		this._onDidRecordUsage.fire(record);
		return record;
	}

	getTodaySummary(): TokenUsageSummary {
		const startOfDay = new Date();
		startOfDay.setHours(0, 0, 0, 0);
		return this.getSummary(startOfDay.getTime());
	}

	getSummary(since: number): TokenUsageSummary {
		const filtered = this.records.filter(r => r.timestamp >= since);
		const byModel = {
			'claude-opus': { inputTokens: 0, outputTokens: 0, costUsd: 0 },
			'claude-sonnet': { inputTokens: 0, outputTokens: 0, costUsd: 0 },
			'claude-haiku': { inputTokens: 0, outputTokens: 0, costUsd: 0 },
		};

		let totalInputTokens = 0;
		let totalOutputTokens = 0;
		let totalCostUsd = 0;

		for (const record of filtered) {
			totalInputTokens += record.inputTokens;
			totalOutputTokens += record.outputTokens;
			totalCostUsd += record.costUsd;
			const modelBucket = byModel[record.model];
			modelBucket.inputTokens += record.inputTokens;
			modelBucket.outputTokens += record.outputTokens;
			modelBucket.costUsd += record.costUsd;
		}

		return { totalInputTokens, totalOutputTokens, totalCostUsd, recordCount: filtered.length, byModel };
	}

	getTodayRecords(): readonly TokenUsageRecord[] {
		const startOfDay = new Date();
		startOfDay.setHours(0, 0, 0, 0);
		return this.records.filter(r => r.timestamp >= startOfDay.getTime());
	}

	calculateCost(model: NyrveModelId, inputTokens: number, outputTokens: number): number {
		const costs = MODEL_COSTS[model];
		return (inputTokens / 1_000_000) * costs.input + (outputTokens / 1_000_000) * costs.output;
	}

	resetToday(): void {
		const startOfDay = new Date();
		startOfDay.setHours(0, 0, 0, 0);
		const cutoff = startOfDay.getTime();
		// Remove today's records
		for (let i = this.records.length - 1; i >= 0; i--) {
			if (this.records[i].timestamp >= cutoff) {
				this.records.splice(i, 1);
			}
		}
	}
}

registerSingleton(INyrveTokenTracker, NyrveTokenTracker, InstantiationType.Delayed);
