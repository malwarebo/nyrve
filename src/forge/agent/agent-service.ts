/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../vs/base/common/cancellation.js';
import { Emitter, Event } from '../../vs/base/common/event.js';
import { Disposable, MutableDisposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { ForgeModelId } from '../core/config.js';
import { ForgeAgentResponse, ForgeMessage, ForgeStreamEvent, IForgeAgentEngine } from './agent-engine.js';
import { IForgeModelRouter } from './model-router.js';
import { IForgeVerificationEngine, VerificationProgress } from './verification-engine.js';
import { VerificationReport } from './verification/report-builder.js';

// --- Types ---

export const enum ForgeAgentState {
	Idle = 'idle',
	Thinking = 'thinking',
	Streaming = 'streaming',
	Verifying = 'verifying',
	Error = 'error',
}

export interface ForgeConversation {
	readonly id: string;
	readonly messages: ForgeMessage[];
	readonly createdAt: number;
}

// --- Service Interface ---

export const IForgeAgentService = createDecorator<IForgeAgentService>('forgeAgentService');

export interface IForgeAgentService {
	readonly _serviceBrand: undefined;

	/** Current agent state. */
	readonly state: ForgeAgentState;

	/** Fires when the agent state changes. */
	readonly onDidChangeState: Event<ForgeAgentState>;

	/** Fires on each streaming delta from the agent. */
	readonly onDidReceiveStreamEvent: Event<ForgeStreamEvent>;

	/** Fires when a new message is added to the conversation. */
	readonly onDidAddMessage: Event<ForgeMessage>;

	/** Get the current conversation history. */
	getConversation(): ForgeConversation;

	/** Send a user message and get a streamed response. */
	sendUserMessage(content: string, model?: ForgeModelId): Promise<ForgeAgentResponse>;

	/** Cancel the current in-progress request. */
	cancelCurrentRequest(): void;

	/** Clear the conversation and start a new one. */
	newConversation(): void;

	/** Get the current active model. */
	getActiveModel(): ForgeModelId;

	/** Set the active model for this session. */
	setActiveModel(model: ForgeModelId): void;

	/** Fires during verification pipeline progress. */
	readonly onDidVerificationProgress: Event<VerificationProgress>;

	/** Fires when verification completes with a report. */
	readonly onDidCompleteVerification: Event<VerificationReport>;

	/** Get the most recent verification report, if any. */
	getLastVerificationReport(): VerificationReport | undefined;
}

// --- Service Implementation ---

export class ForgeAgentService extends Disposable implements IForgeAgentService {
	declare readonly _serviceBrand: undefined;

	private _state: ForgeAgentState = ForgeAgentState.Idle;

	private readonly _onDidChangeState = this._register(new Emitter<ForgeAgentState>());
	readonly onDidChangeState: Event<ForgeAgentState> = this._onDidChangeState.event;

	private readonly _onDidReceiveStreamEvent = this._register(new Emitter<ForgeStreamEvent>());
	readonly onDidReceiveStreamEvent: Event<ForgeStreamEvent> = this._onDidReceiveStreamEvent.event;

	private readonly _onDidAddMessage = this._register(new Emitter<ForgeMessage>());
	readonly onDidAddMessage: Event<ForgeMessage> = this._onDidAddMessage.event;

	private readonly messages: ForgeMessage[] = [];
	private readonly conversationId: string;
	private readonly conversationCreatedAt: number;

	private readonly _onDidVerificationProgress = this._register(new Emitter<VerificationProgress>());
	readonly onDidVerificationProgress: Event<VerificationProgress> = this._onDidVerificationProgress.event;

	private readonly _onDidCompleteVerification = this._register(new Emitter<VerificationReport>());
	readonly onDidCompleteVerification: Event<VerificationReport> = this._onDidCompleteVerification.event;

	private readonly currentCancellation = this._register(new MutableDisposable<CancellationTokenSource>());
	private _activeModel: ForgeModelId | undefined;
	private _lastVerificationReport: VerificationReport | undefined;

	constructor(
		@IForgeAgentEngine private readonly agentEngine: IForgeAgentEngine,
		@IForgeModelRouter private readonly modelRouter: IForgeModelRouter,
		@IForgeVerificationEngine private readonly verificationEngine: IForgeVerificationEngine,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this.conversationId = this._generateId();
		this.conversationCreatedAt = Date.now();

		// Forward stream events from the engine
		this._register(this.agentEngine.onDidReceiveStreamEvent(e => {
			if (e.type === 'message_start') {
				this._setState(ForgeAgentState.Streaming);
			}
			this._onDidReceiveStreamEvent.fire(e);
		}));

		// Forward verification progress
		this._register(this.verificationEngine.onDidProgress(p => {
			this._onDidVerificationProgress.fire(p);
		}));
	}

	get state(): ForgeAgentState {
		return this._state;
	}

	getConversation(): ForgeConversation {
		return {
			id: this.conversationId,
			messages: [...this.messages],
			createdAt: this.conversationCreatedAt,
		};
	}

	async sendUserMessage(content: string, model?: ForgeModelId): Promise<ForgeAgentResponse> {
		// Add the user message
		const userMessage: ForgeMessage = {
			role: 'user',
			content,
			timestamp: Date.now(),
		};
		this.messages.push(userMessage);
		this._onDidAddMessage.fire(userMessage);

		this._setState(ForgeAgentState.Thinking);

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
			const assistantMessage: ForgeMessage = {
				role: 'assistant',
				content: response.content,
				timestamp: Date.now(),
				model: response.model,
				tokenUsage: { input: response.inputTokens, output: response.outputTokens },
			};
			this.messages.push(assistantMessage);
			this._onDidAddMessage.fire(assistantMessage);

			this._setState(ForgeAgentState.Idle);
			return response;
		} catch (e) {
			this.logService.error('[Forge] Agent request failed:', e);
			this._setState(ForgeAgentState.Error);
			throw e;
		}
	}

	cancelCurrentRequest(): void {
		if (this.currentCancellation.value) {
			this.currentCancellation.value.cancel();
			this._setState(ForgeAgentState.Idle);
			this.logService.info('[Forge] Request cancelled');
		}
	}

	newConversation(): void {
		this.messages.length = 0;
		this._setState(ForgeAgentState.Idle);
		this.logService.info('[Forge] New conversation started');
	}

	getActiveModel(): ForgeModelId {
		return this._activeModel ?? this.modelRouter.getChatModel();
	}

	setActiveModel(model: ForgeModelId): void {
		this._activeModel = model;
		this.logService.info(`[Forge] Active model set to ${model}`);
	}

	getLastVerificationReport(): VerificationReport | undefined {
		return this._lastVerificationReport;
	}

	/**
	 * Run verification on a changeset. Called by the diff review flow after
	 * the agent produces file changes, before showing them to the user.
	 */
	async verifyChangeset(changeset: import('../ui/diff-review/diff-panel.js').ForgeChangeSet): Promise<VerificationReport> {
		this._setState(ForgeAgentState.Verifying);
		try {
			const report = await this.verificationEngine.verify(changeset);
			this._lastVerificationReport = report;
			this._onDidCompleteVerification.fire(report);
			return report;
		} finally {
			this._setState(ForgeAgentState.Idle);
		}
	}

	private _setState(state: ForgeAgentState): void {
		if (this._state !== state) {
			this._state = state;
			this._onDidChangeState.fire(state);
		}
	}

	private _buildSystemPrompt(): string {
		return [
			'You are Forge, an AI coding assistant built into the IDE.',
			'You have full awareness of the user\'s editor state, open files, and project context.',
			'Be concise, helpful, and produce high-quality code.',
			'When making code changes, be precise about file paths and line numbers.',
		].join(' ');
	}

	private _generateId(): string {
		return `forge-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	}
}

registerSingleton(IForgeAgentService, ForgeAgentService, InstantiationType.Delayed);
