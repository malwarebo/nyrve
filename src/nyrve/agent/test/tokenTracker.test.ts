/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "assert";
import { NullLogService } from "../../../vs/platform/log/common/log.js";
import { ensureNoDisposablesAreLeakedInTestSuite } from "../../../vs/base/test/common/utils.js";
import { NyrveTokenTracker } from "../token-tracker.js";

suite("Nyrve: TokenTracker", () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let tracker: NyrveTokenTracker;

	setup(() => {
		tracker = store.add(new NyrveTokenTracker(new NullLogService()));
	});

	test("recordUsage creates a record with correct cost", () => {
		const record = tracker.recordUsage("claude-sonnet", 1000, 500);
		assert.strictEqual(record.model, "claude-sonnet");
		assert.strictEqual(record.inputTokens, 1000);
		assert.strictEqual(record.outputTokens, 500);
		// Sonnet: (1000/1M)*3.0 + (500/1M)*15.0 = 0.003 + 0.0075 = 0.0105
		assert.ok(Math.abs(record.costUsd - 0.0105) < 0.0001);
	});

	test("recordUsage fires onDidRecordUsage event", () => {
		let firedRecord: typeof tracker extends {
			recordUsage(...args: infer _): infer R;
		}
			? R
			: never;
		store.add(
			tracker.onDidRecordUsage((r) => {
				firedRecord = r;
			}),
		);
		const record = tracker.recordUsage("claude-haiku", 100, 200);
		assert.strictEqual(firedRecord!, record);
	});

	test("calculateCost returns correct values per model", () => {
		// Opus: (1M/1M)*15 + (1M/1M)*75 = 90
		assert.strictEqual(
			tracker.calculateCost("claude-opus", 1_000_000, 1_000_000),
			90,
		);
		// Sonnet: (1M/1M)*3 + (1M/1M)*15 = 18
		assert.strictEqual(
			tracker.calculateCost("claude-sonnet", 1_000_000, 1_000_000),
			18,
		);
		// Haiku: (1M/1M)*0.25 + (1M/1M)*1.25 = 1.5
		assert.strictEqual(
			tracker.calculateCost("claude-haiku", 1_000_000, 1_000_000),
			1.5,
		);
	});

	test("getTodaySummary aggregates correctly", () => {
		tracker.recordUsage("claude-sonnet", 1000, 500);
		tracker.recordUsage("claude-haiku", 2000, 300);
		tracker.recordUsage("claude-sonnet", 500, 100);

		const summary = tracker.getTodaySummary();
		assert.strictEqual(summary.totalInputTokens, 3500);
		assert.strictEqual(summary.totalOutputTokens, 900);
		assert.strictEqual(summary.recordCount, 3);
		assert.strictEqual(summary.byModel["claude-sonnet"].inputTokens, 1500);
		assert.strictEqual(summary.byModel["claude-haiku"].inputTokens, 2000);
		assert.strictEqual(summary.byModel["claude-opus"].inputTokens, 0);
	});

	test("getTodayRecords returns only today records", () => {
		tracker.recordUsage("claude-sonnet", 100, 50);
		tracker.recordUsage("claude-haiku", 200, 100);
		const records = tracker.getTodayRecords();
		assert.strictEqual(records.length, 2);
	});

	test("resetToday clears today records", () => {
		tracker.recordUsage("claude-sonnet", 100, 50);
		tracker.recordUsage("claude-haiku", 200, 100);
		assert.strictEqual(tracker.getTodayRecords().length, 2);
		tracker.resetToday();
		assert.strictEqual(tracker.getTodayRecords().length, 0);
	});

	test("getSummary filters by timestamp", () => {
		tracker.recordUsage("claude-sonnet", 100, 50);
		const futureStamp = Date.now() + 100_000;
		const summary = tracker.getSummary(futureStamp);
		assert.strictEqual(summary.recordCount, 0);
		assert.strictEqual(summary.totalInputTokens, 0);
	});
});
