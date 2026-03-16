/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../vs/base/common/cancellation.js';
import { Emitter, Event } from '../../vs/base/common/event.js';
import { Disposable, MutableDisposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { NyrveModelId } from '../core/config.js';
import { NyrveAgentResponse, NyrveMessage, NyrveStreamEvent, INyrveAgentEngine } from './agent-engine.js';
import { INyrveModelRouter } from './model-router.js';
import { INyrveVerificationEngine, VerificationProgress } from './verification-engine.js';
import { VerificationReport } from './verification/report-builder.js';

// --- Types ---

export const enum NyrveAgentState {
	Idle = 'idle',
	Thinking = 'thinking',
	Streaming = 'streaming',
	Verifying = 'verifying',
	Error = 'error',
}

export interface NyrveConversation {
	readonly id: string;
	readonly messages: NyrveMessage[];
	readonly createdAt: number;
}

// --- Service Interface ---

export const INyrveAgentService = createDecorator<INyrveAgentService>('nyrveAgentService');

export interface INyrveAgentService {
	readonly _serviceBrand: undefined;

	/** Current agent state. */
	readonly state: NyrveAgentState;

	/** Fires when the agent state changes. */
	readonly onDidChangeState: Event<NyrveAgentState>;

	/** Fires on each streaming delta from the agent. */
	readonly onDidReceiveStreamEvent: Event<NyrveStreamEvent>;

	/** Fires when a new message is added to the conversation. */
	readonly onDidAddMessage: Event<NyrveMessage>;

	/** Get the current conversation history. */
	getConversation(): NyrveConversation;

	/** Send a user message and get a streamed response. */
	sendUserMessage(content: string, model?: NyrveModelId): Promise<NyrveAgentResponse>;

	/** Cancel the current in-progress request. */
	cancelCurrentRequest(): void;

	/** Clear the conversation and start a new one. */
	newConversation(): void;

	/** Get the current active model. */
	getActiveModel(): NyrveModelId;

	/** Set the active model for this session. */
	setActiveModel(model: NyrveModelId): void;

	/** Fires during verification pipeline progress. */
	readonly onDidVerificationProgress: Event<VerificationProgress>;

	/** Fires when verification completes with a report. */
	readonly onDidCompleteVerification: Event<VerificationReport>;

	/** Get the most recent verification report, if any. */
	getLastVerificationReport(): VerificationReport | undefined;
}

// --- Service Implementation ---

export class NyrveAgentService extends Disposable implements INyrveAgentService {
	declare readonly _serviceBrand: undefined;

	private _state: NyrveAgentState = NyrveAgentState.Idle;

	private readonly _onDidChangeState = this._register(new Emitter<NyrveAgentState>());
	readonly onDidChangeState: Event<NyrveAgentState> = this._onDidChangeState.event;

	private readonly _onDidReceiveStreamEvent = this._register(new Emitter<NyrveStreamEvent>());
	readonly onDidReceiveStreamEvent: Event<NyrveStreamEvent> = this._onDidReceiveStreamEvent.event;

	private readonly _onDidAddMessage = this._register(new Emitter<NyrveMessage>());
	readonly onDidAddMessage: Event<NyrveMessage> = this._onDidAddMessage.event;

	private readonly messages: NyrveMessage[] = [];
	private readonly conversationId: string;
	private readonly conversationCreatedAt: number;

	private readonly _onDidVerificationProgress = this._register(new Emitter<VerificationProgress>());
	readonly onDidVerificationProgress: Event<VerificationProgress> = this._onDidVerificationProgress.event;

	private readonly _onDidCompleteVerification = this._register(new Emitter<VerificationReport>());
	readonly onDidCompleteVerification: Event<VerificationReport> = this._onDidCompleteVerification.event;

	private readonly currentCancellation = this._register(new MutableDisposable<CancellationTokenSource>());
	private _activeModel: NyrveModelId | undefined;
	private _lastVerificationReport: VerificationReport | undefined;

	constructor(
		@INyrveAgentEngine private readonly agentEngine: INyrveAgentEngine,
		@INyrveModelRouter private readonly modelRouter: INyrveModelRouter,
		@INyrveVerificationEngine private readonly verificationEngine: INyrveVerificationEngine,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this.conversationId = this._generateId();
		this.conversationCreatedAt = Date.now();

		// Forward stream events from the engine
		this._register(this.agentEngine.onDidReceiveStreamEvent(e => {
			if (e.type === 'message_start') {
				this._setState(NyrveAgentState.Streaming);
			}
			this._onDidReceiveStreamEvent.fire(e);
		}));

		// Forward verification progress
		this._register(this.verificationEngine.onDidProgress(p => {
			this._onDidVerificationProgress.fire(p);
		}));
	}

	get state(): NyrveAgentState {
		return this._state;
	}

	getConversation(): NyrveConversation {
		return {
			id: this.conversationId,
			messages: [...this.messages],
			createdAt: this.conversationCreatedAt,
		};
	}

	async sendUserMessage(content: string, model?: NyrveModelId): Promise<NyrveAgentResponse> {
		// Add the user message
		const userMessage: NyrveMessage = {
			role: 'user',
			content,
			timestamp: Date.now(),
		};
		this.messages.push(userMessage);
		this._onDidAddMessage.fire(userMessage);

		this._setState(NyrveAgentState.Thinking);

		const cts = new CancellationTokenSource();
		this.currentCancellation.value = cts;

		try {
			const response = await this.agentEngine.sendMessage(
				{
					messages: this.messages,
					model: model ?? this._activeModel,
					systemPrompt: this._buildSystemPrompt(),
				},
				cts.token,
			);

			// Add the assistant message
			const assistantMessage: NyrveMessage = {
				role: 'assistant',
				content: response.content,
				timestamp: Date.now(),
				model: response.model,
				tokenUsage: { input: response.inputTokens, output: response.outputTokens },
			};
			this.messages.push(assistantMessage);
			this._onDidAddMessage.fire(assistantMessage);

			this._setState(NyrveAgentState.Idle);
			return response;
		} catch (e) {
			this.logService.error('[Nyrve] Agent request failed:', e);
			this._setState(NyrveAgentState.Error);
			throw e;
		}
	}

	cancelCurrentRequest(): void {
		if (this.currentCancellation.value) {
			this.currentCancellation.value.cancel();
			this._setState(NyrveAgentState.Idle);
			this.logService.info('[Nyrve] Request cancelled');
		}
	}

	newConversation(): void {
		this.messages.length = 0;
		this._setState(NyrveAgentState.Idle);
		this.logService.info('[Nyrve] New conversation started');
	}

	getActiveModel(): NyrveModelId {
		return this._activeModel ?? this.modelRouter.getChatModel();
	}

	setActiveModel(model: NyrveModelId): void {
		this._activeModel = model;
		this.logService.info(`[Nyrve] Active model set to ${model}`);
	}

	getLastVerificationReport(): VerificationReport | undefined {
		return this._lastVerificationReport;
	}

	/**
	 * Run verification on a changeset. Called by the diff review flow after
	 * the agent produces file changes, before showing them to the user.
	 */
	async verifyChangeset(changeset: import('../ui/diff-review/diff-panel.js').NyrveChangeSet): Promise<VerificationReport> {
		this._setState(NyrveAgentState.Verifying);
		try {
			const report = await this.verificationEngine.verify(changeset);
			this._lastVerificationReport = report;
			this._onDidCompleteVerification.fire(report);
			return report;
		} finally {
			this._setState(NyrveAgentState.Idle);
		}
	}

	private _setState(state: NyrveAgentState): void {
		if (this._state !== state) {
			this._state = state;
			this._onDidChangeState.fire(state);
		}
	}

	private _buildSystemPrompt(): string {
		return [
			'You are Nyrve, an AI coding assistant built into the IDE.',
			'You have full awareness of the user\'s editor state, open files, and project context.',
			'Be concise, helpful, and produce high-quality code.',
			'When making code changes, be precise about file paths and line numbers.',
		].join(' ');
	}

	private _generateId(): string {
		return `nyrve-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	}
}

registerSingleton(INyrveAgentService, NyrveAgentService, InstantiationType.Delayed);
