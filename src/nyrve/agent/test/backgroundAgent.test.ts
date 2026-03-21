/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "assert";
import { Emitter, Event } from "../../../vs/base/common/event.js";
import { NullLogService } from "../../../vs/platform/log/common/log.js";
import { ensureNoDisposablesAreLeakedInTestSuite } from "../../../vs/base/test/common/utils.js";
import { mock } from "../../../vs/base/test/common/mock.js";
import {
	NyrveBackgroundAgent,
	BackgroundAgentState,
} from "../background-agent.js";
import { INyrveAgentEngine, NyrveStreamEvent } from "../agent-engine.js";
import { INyrveModelRouter } from "../model-router.js";
import { INyrveTokenTracker, TokenUsageRecord } from "../token-tracker.js";
import { IConfigurationService } from "../../../vs/platform/configuration/common/configuration.js";
import { TestConfigurationService } from "../../../vs/platform/configuration/test/common/testConfigurationService.js";
import { ITextFileService } from "../../../vs/workbench/services/textfile/common/textfiles.js";
import { NyrveModelId } from "../../core/config.js";

suite("Nyrve: BackgroundAgent", () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createBackgroundAgent(
		config?: Record<string, unknown>,
	): NyrveBackgroundAgent {
		const streamEmitter = store.add(new Emitter<NyrveStreamEvent>());
		const usageEmitter = store.add(new Emitter<TokenUsageRecord>());

		const agentEngine = new (class extends mock<INyrveAgentEngine>() {
			override readonly onDidReceiveStreamEvent: Event<NyrveStreamEvent> =
				streamEmitter.event;
			override isProcessing(): boolean {
				return false;
			}
		})();

		const modelRouter = new (class extends mock<INyrveModelRouter>() {
			override getBackgroundModel(): NyrveModelId {
				return "claude-haiku";
			}
		})();

		const tokenTracker = new (class extends mock<INyrveTokenTracker>() {
			override readonly onDidRecordUsage: Event<TokenUsageRecord> =
				usageEmitter.event;
			override recordUsage(): TokenUsageRecord {
				return {
					timestamp: Date.now(),
					model: "claude-haiku",
					inputTokens: 0,
					outputTokens: 0,
					costUsd: 0,
				};
			}
		})();

		const configService = new TestConfigurationService({
			"nyrve.backgroundAgent.enabled": true,
			"nyrve.backgroundAgent.mode": "on-save",
			"nyrve.backgroundAgent.dailyTokenBudget": 500000,
			"nyrve.backgroundAgent.minSeverity": "info",
			...config,
		});

		const textFileService = new (class extends mock<ITextFileService>() {
			override readonly files = new (class extends mock<
				ITextFileService["files"]
			>() {
				override readonly onDidSave: Event<any> = Event.None;
			})();
		})();

		return store.add(
			new NyrveBackgroundAgent(
				agentEngine,
				modelRouter,
				tokenTracker,
				textFileService,
				configService as unknown as IConfigurationService,
				new NullLogService(),
			),
		);
	}

	test("initial state is Disabled", () => {
		const agent = createBackgroundAgent();
		assert.strictEqual(agent.state, BackgroundAgentState.Disabled);
	});

	test("start transitions to Idle when enabled", () => {
		const agent = createBackgroundAgent();
		agent.start();
		assert.strictEqual(agent.state, BackgroundAgentState.Idle);
	});

	test("start stays Disabled when mode is off", () => {
		const agent = createBackgroundAgent({
			"nyrve.backgroundAgent.mode": "off",
		});
		agent.start();
		assert.strictEqual(agent.state, BackgroundAgentState.Disabled);
	});

	test("start stays Disabled when enabled=false", () => {
		const agent = createBackgroundAgent({
			"nyrve.backgroundAgent.enabled": false,
		});
		agent.start();
		assert.strictEqual(agent.state, BackgroundAgentState.Disabled);
	});

	test("pause sets state to Paused", () => {
		const agent = createBackgroundAgent();
		agent.start();
		agent.pause();
		assert.strictEqual(agent.state, BackgroundAgentState.Paused);
	});

	test("resume sets state to Idle from Paused", () => {
		const agent = createBackgroundAgent();
		agent.start();
		agent.pause();
		agent.resume();
		assert.strictEqual(agent.state, BackgroundAgentState.Idle);
	});

	test("resume is no-op when not Paused", () => {
		const agent = createBackgroundAgent();
		agent.resume();
		assert.strictEqual(agent.state, BackgroundAgentState.Disabled);
	});

	test("getSuggestions returns empty initially", () => {
		const agent = createBackgroundAgent();
		assert.deepStrictEqual(agent.getSuggestions(), []);
	});

	test("getFileSuggestions returns empty for unknown file", () => {
		const agent = createBackgroundAgent();
		assert.deepStrictEqual(agent.getFileSuggestions("/some/file.ts"), []);
	});

	test("dismissAll dismisses all suggestions", () => {
		const agent = createBackgroundAgent();
		agent.dismissAll();
		assert.deepStrictEqual(agent.getSuggestions(), []);
	});

	test("getTodayTokenUsage returns 0 initially", () => {
		const agent = createBackgroundAgent();
		assert.strictEqual(agent.getTodayTokenUsage(), 0);
	});

	test("onDidChangeState fires on state transitions", () => {
		const agent = createBackgroundAgent();
		const states: BackgroundAgentState[] = [];
		store.add(agent.onDidChangeState((s) => states.push(s)));

		agent.start();
		agent.pause();
		agent.resume();

		assert.deepStrictEqual(states, [
			BackgroundAgentState.Idle,
			BackgroundAgentState.Paused,
			BackgroundAgentState.Idle,
		]);
	});

	test("analyzeFile is no-op when paused", async () => {
		const agent = createBackgroundAgent();
		agent.start();
		agent.pause();
		await agent.analyzeFile("/some/file.ts");
		assert.strictEqual(agent.state, BackgroundAgentState.Paused);
	});

	test("analyzeFile is no-op when disabled", async () => {
		const agent = createBackgroundAgent();
		await agent.analyzeFile("/some/file.ts");
		assert.strictEqual(agent.state, BackgroundAgentState.Disabled);
	});
});
