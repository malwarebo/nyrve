/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "assert";
import { Emitter, Event } from "../../../vs/base/common/event.js";
import { NullLogService } from "../../../vs/platform/log/common/log.js";
import { ensureNoDisposablesAreLeakedInTestSuite } from "../../../vs/base/test/common/utils.js";
import { mock } from "../../../vs/base/test/common/mock.js";
import { NyrveAgentService, NyrveAgentState } from "../agent-service.js";
import {
	INyrveAgentEngine,
	NyrveAgentRequest,
	NyrveAgentResponse,
	NyrveStreamEvent,
} from "../agent-engine.js";
import { INyrveModelRouter } from "../model-router.js";
import { INyrveEditorBridge, EditorState } from "../../context/editor-bridge.js";
import { IFileService } from "../../../vs/platform/files/common/files.js";
import {
	INyrveVerificationEngine,
	VerificationProgress,
} from "../verification-engine.js";
import { NyrveModelId } from "../../core/config.js";
import { CancellationToken } from "../../../vs/base/common/cancellation.js";

suite("Nyrve: AgentService", () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createAgentService(opts?: {
		sendMessageResult?: Partial<NyrveAgentResponse>;
		sendMessageError?: Error;
	}): NyrveAgentService {
		const streamEmitter = store.add(new Emitter<NyrveStreamEvent>());
		const verifyProgressEmitter = store.add(
			new Emitter<VerificationProgress>(),
		);

		const agentEngine = new (class extends mock<INyrveAgentEngine>() {
			override readonly onDidReceiveStreamEvent: Event<NyrveStreamEvent> =
				streamEmitter.event;
			override isProcessing(): boolean {
				return false;
			}
			override async sendMessage(
				_request: NyrveAgentRequest,
				_cancellation: CancellationToken,
			): Promise<NyrveAgentResponse> {
				if (opts?.sendMessageError) {
					throw opts.sendMessageError;
				}
				return {
					content: "test response",
					model: "claude-sonnet" as NyrveModelId,
					inputTokens: 100,
					outputTokens: 50,
					stopReason: "end_turn",
					...opts?.sendMessageResult,
				};
			}
		})();

		const modelRouter = new (class extends mock<INyrveModelRouter>() {
			override getChatModel(): NyrveModelId {
				return "claude-sonnet";
			}
		})();

		const verificationEngine =
			new (class extends mock<INyrveVerificationEngine>() {
				override readonly onDidProgress: Event<VerificationProgress> =
					verifyProgressEmitter.event;
			})();

		const editorBridge = new (class extends mock<INyrveEditorBridge>() {
			override getEditorState(): EditorState {
				return {
					activeFilePath: undefined,
					activeFileLanguage: undefined,
					cursorPosition: undefined,
					selection: undefined,
					selectedText: undefined,
					openTabs: [],
					diagnostics: [],
					gitBranch: undefined,
					projectRoot: '/test',
				};
			}
			override getActiveFileContent(): string | undefined {
				return undefined;
			}
		})();

		const fileService = new (class extends mock<IFileService>() {
			override async readFile(): Promise<any> {
				throw new Error('not found');
			}
		})();

		return store.add(
			new NyrveAgentService(
				agentEngine,
				modelRouter,
				verificationEngine,
				editorBridge,
				fileService,
				new NullLogService(),
			),
		);
	}

	test("initial state is Idle", () => {
		const service = createAgentService();
		assert.strictEqual(service.state, NyrveAgentState.Idle);
	});

	test("getConversation returns empty conversation initially", () => {
		const service = createAgentService();
		const conversation = service.getConversation();
		assert.strictEqual(conversation.messages.length, 0);
		assert.ok(conversation.id.startsWith("nyrve-"));
	});

	test("sendUserMessage adds user and assistant messages", async () => {
		const service = createAgentService();
		await service.sendUserMessage("hello");

		const conversation = service.getConversation();
		assert.strictEqual(conversation.messages.length, 2);
		assert.strictEqual(conversation.messages[0].role, "user");
		assert.strictEqual(conversation.messages[0].content, "hello");
		assert.strictEqual(conversation.messages[1].role, "assistant");
		assert.strictEqual(conversation.messages[1].content, "test response");
	});

	test("sendUserMessage transitions state correctly", async () => {
		const service = createAgentService();
		const states: NyrveAgentState[] = [];
		store.add(service.onDidChangeState((s) => states.push(s)));

		await service.sendUserMessage("hello");

		assert.ok(states.includes(NyrveAgentState.Thinking));
		assert.strictEqual(states[states.length - 1], NyrveAgentState.Idle);
	});

	test("sendUserMessage transitions to Error on failure", async () => {
		const service = createAgentService({
			sendMessageError: new Error("API fail"),
		});
		const states: NyrveAgentState[] = [];
		store.add(service.onDidChangeState((s) => states.push(s)));

		await assert.rejects(() => service.sendUserMessage("hello"), /API fail/);

		assert.strictEqual(states[states.length - 1], NyrveAgentState.Error);
	});

	test("onDidAddMessage fires for user and assistant messages", async () => {
		const service = createAgentService();
		const messages: Array<{ role: string; content: string }> = [];
		store.add(
			service.onDidAddMessage((m) =>
				messages.push({ role: m.role, content: m.content }),
			),
		);

		await service.sendUserMessage("test");

		assert.strictEqual(messages.length, 2);
		assert.strictEqual(messages[0].role, "user");
		assert.strictEqual(messages[1].role, "assistant");
	});

	test("cancelCurrentRequest sets state to Idle", () => {
		const service = createAgentService();
		service.cancelCurrentRequest();
		assert.strictEqual(service.state, NyrveAgentState.Idle);
	});

	test("newConversation clears messages", async () => {
		const service = createAgentService();
		await service.sendUserMessage("hello");
		assert.strictEqual(service.getConversation().messages.length, 2);

		service.newConversation();
		assert.strictEqual(service.getConversation().messages.length, 0);
		assert.strictEqual(service.state, NyrveAgentState.Idle);
	});

	test("getActiveModel returns default from router", () => {
		const service = createAgentService();
		assert.strictEqual(service.getActiveModel(), "claude-sonnet");
	});

	test("setActiveModel overrides active model", () => {
		const service = createAgentService();
		service.setActiveModel("claude-opus");
		assert.strictEqual(service.getActiveModel(), "claude-opus");
	});

	test("getLastVerificationReport returns undefined initially", () => {
		const service = createAgentService();
		assert.strictEqual(service.getLastVerificationReport(), undefined);
	});
});
