/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "assert";
import { ensureNoDisposablesAreLeakedInTestSuite } from "../../../vs/base/test/common/utils.js";
import { mock } from "../../../vs/base/test/common/mock.js";
import { NullLogService } from "../../../vs/platform/log/common/log.js";
import {
	NyrveCompletionTrigger,
	EditorChangeEvent,
} from "../completion-trigger.js";
import {
	INyrveAgentService,
	NyrveAgentState,
} from "../../agent/agent-service.js";
import { IConfigurationService } from "../../../vs/platform/configuration/common/configuration.js";
import { TestConfigurationService } from "../../../vs/platform/configuration/test/common/testConfigurationService.js";

suite("Nyrve: CompletionTrigger", () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let agentState: NyrveAgentState;

	function createTrigger(
		overrides?: Record<string, unknown>,
	): NyrveCompletionTrigger {
		agentState = NyrveAgentState.Idle;
		const agentService = new (class extends mock<INyrveAgentService>() {
			override get state() {
				return agentState;
			}
		})();
		const configService = new TestConfigurationService({
			"nyrve.completions.enabled": true,
			"nyrve.completions.triggerDelay": 150,
			"nyrve.completions.enabledLanguages": ["*"],
			"nyrve.completions.disabledLanguages": [],
			...overrides,
		});

		return store.add(
			new NyrveCompletionTrigger(
				agentService as unknown as INyrveAgentService,
				configService as unknown as IConfigurationService,
				new NullLogService(),
			),
		);
	}

	function makeEvent(
		overrides?: Partial<EditorChangeEvent>,
	): EditorChangeEvent {
		return {
			text: "a",
			isExplicit: false,
			lineNumber: 10,
			column: 15,
			lineText: "const x = a",
			hasSelection: false,
			languageId: "typescript",
			totalLines: 100,
			isInsideString: false,
			isInsideComment: false,
			...overrides,
		};
	}

	test("explicit trigger fires immediately", () => {
		const trigger = createTrigger();
		const result = trigger.shouldTrigger(makeEvent({ isExplicit: true }));
		assert.strictEqual(result.trigger, true);
		assert.strictEqual(result.kind, "explicit");
		assert.strictEqual(result.delay, 0);
	});

	test("does not trigger when completions disabled", () => {
		const trigger = createTrigger({ "nyrve.completions.enabled": false });
		const result = trigger.shouldTrigger(makeEvent());
		assert.strictEqual(result.trigger, false);
	});

	test("does not trigger when language disabled", () => {
		const trigger = createTrigger({
			"nyrve.completions.disabledLanguages": ["typescript"],
		});
		const result = trigger.shouldTrigger(
			makeEvent({ languageId: "typescript" }),
		);
		assert.strictEqual(result.trigger, false);
	});

	test("does not trigger when text is selected", () => {
		const trigger = createTrigger();
		const result = trigger.shouldTrigger(makeEvent({ hasSelection: true }));
		assert.strictEqual(result.trigger, false);
	});

	test("does not trigger when agent is streaming", () => {
		const trigger = createTrigger();
		agentState = NyrveAgentState.Streaming;
		const result = trigger.shouldTrigger(makeEvent());
		assert.strictEqual(result.trigger, false);
	});

	test("triggers with short delay for newline", () => {
		const trigger = createTrigger();
		const result = trigger.shouldTrigger(makeEvent({ text: "\n" }));
		assert.strictEqual(result.trigger, true);
		assert.strictEqual(result.kind, "line_start");
		assert.strictEqual(result.delay, 100);
	});

	test("triggers with longer delay inside string", () => {
		const trigger = createTrigger();
		const result = trigger.shouldTrigger(makeEvent({ isInsideString: true }));
		assert.strictEqual(result.trigger, true);
		assert.strictEqual(result.delay, 200);
	});

	test("triggers with longer delay for large files", () => {
		const trigger = createTrigger();
		const result = trigger.shouldTrigger(
			makeEvent({ totalLines: 20000, text: "." }),
		);
		assert.strictEqual(result.trigger, true);
		assert.strictEqual(result.delay, 300);
	});

	test("recordRateLimit prevents triggering", () => {
		const trigger = createTrigger();
		trigger.recordRateLimit();
		const result = trigger.shouldTrigger(makeEvent());
		assert.strictEqual(result.trigger, false);
		assert.strictEqual(result.reason, "rate limited");
	});

	test("clearRateLimit allows triggering again", () => {
		const trigger = createTrigger();
		trigger.recordRateLimit();
		trigger.clearRateLimit();
		const result = trigger.shouldTrigger(makeEvent());
		assert.strictEqual(result.trigger, true);
	});

	test("whitespace trigger fires with short delay", () => {
		const trigger = createTrigger();
		const result = trigger.shouldTrigger(makeEvent({ text: " " }));
		assert.strictEqual(result.trigger, true);
		assert.strictEqual(result.delay, 100);
	});

	test("enabled language check with wildcard", () => {
		const trigger = createTrigger({
			"nyrve.completions.enabledLanguages": ["*"],
		});
		const result = trigger.shouldTrigger(makeEvent({ languageId: "python" }));
		assert.strictEqual(result.trigger, true);
	});

	test("enabled language check with specific list", () => {
		const trigger = createTrigger({
			"nyrve.completions.enabledLanguages": ["python"],
		});
		const result = trigger.shouldTrigger(
			makeEvent({ languageId: "javascript" }),
		);
		assert.strictEqual(result.trigger, false);
	});
});
