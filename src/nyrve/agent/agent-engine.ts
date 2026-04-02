/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../vs/base/common/cancellation.js';
import { Emitter, Event } from '../../vs/base/common/event.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { NyrveModelId, INyrveConfigService } from '../core/config.js';
import { INyrveApiClient, AnthropicStreamEvent } from '../core/api-client.js';
import { INyrveModelRouter } from './model-router.js';
import { INyrveTokenTracker } from './token-tracker.js';

// --- Types ---

export interface NyrveMessage {
	readonly role: 'user' | 'assistant';
	readonly content: string;
	readonly timestamp: number;
	readonly model?: NyrveModelId;
	readonly tokenUsage?: { input: number; output: number };
}

export interface NyrveStreamEvent {
	readonly type: 'text_delta' | 'message_start' | 'message_stop' | 'error';
	readonly text?: string;
	readonly error?: string;
}

export interface NyrveAgentRequest {
	readonly messages: NyrveMessage[];
	readonly model?: NyrveModelId;
	readonly systemPrompt?: string;
	readonly maxTokens?: number;
}

export interface NyrveAgentResponse {
	readonly content: string;
	readonly model: NyrveModelId;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly stopReason: string;
}

// --- Service Interface ---

export const INyrveAgentEngine = createDecorator<INyrveAgentEngine>('nyrveAgentEngine');

export interface INyrveAgentEngine {
	readonly _serviceBrand: undefined;

	/** Fires on each streaming token delta. */
	readonly onDidReceiveStreamEvent: Event<NyrveStreamEvent>;

	/**
	 * Send a message to the Claude API and stream the response.
	 * Returns the complete response when streaming finishes.
	 */
	sendMessage(request: NyrveAgentRequest, cancellation: CancellationToken): Promise<NyrveAgentResponse>;

	/** Check if the engine is currently processing a request. */
	isProcessing(): boolean;
}

// --- Service Implementation ---

export class NyrveAgentEngine extends Disposable implements INyrveAgentEngine {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidReceiveStreamEvent = this._register(new Emitter<NyrveStreamEvent>());
	readonly onDidReceiveStreamEvent: Event<NyrveStreamEvent> = this._onDidReceiveStreamEvent.event;

	private _isProcessing = false;

	constructor(
		@INyrveConfigService private readonly configService: INyrveConfigService,
		@INyrveApiClient private readonly apiClient: INyrveApiClient,
		@INyrveModelRouter private readonly modelRouter: INyrveModelRouter,
		@INyrveTokenTracker private readonly tokenTracker: INyrveTokenTracker,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	isProcessing(): boolean {
		return this._isProcessing;
	}

	async sendMessage(request: NyrveAgentRequest, cancellation: CancellationToken): Promise<NyrveAgentResponse> {
		const apiKey = await this.configService.getApiKey();
		if (!apiKey) {
			throw new Error('Anthropic API key not configured. Set it in Nyrve settings.');
		}

		const model = request.model ?? this.modelRouter.getChatModel();
		const apiModelId = this.modelRouter.getApiModelId(model);
		const maxTokens = request.maxTokens ?? this.configService.getMaxTokensPerRequest();
		const useStreaming = this.configService.isStreamingEnabled();

		this._isProcessing = true;
		this.logService.info(`[Nyrve] Sending request to ${apiModelId} (streaming=${useStreaming})`);

		try {
			const response = useStreaming
				? await this._sendStreaming(apiKey, apiModelId, request, maxTokens, cancellation)
				: await this._sendNonStreaming(apiKey, apiModelId, request, maxTokens);
			this.tokenTracker.recordUsage(model, response.inputTokens, response.outputTokens);
			return { ...response, model };
		} finally {
			this._isProcessing = false;
		}
	}

	private async _sendStreaming(
		apiKey: string,
		apiModelId: string,
		request: NyrveAgentRequest,
		maxTokens: number,
		cancellation: CancellationToken,
	): Promise<Omit<NyrveAgentResponse, 'model'>> {
		const apiMessages = request.messages.map(m => ({
			role: m.role,
			content: m.content,
		}));

		let fullContent = '';
		let inputTokens = 0;
		let outputTokens = 0;
		let stopReason = 'end_turn';

		const abortController = new AbortController();
		const cancelListener = cancellation.onCancellationRequested(() => {
			abortController.abort();
		});

		this._onDidReceiveStreamEvent.fire({ type: 'message_start' });

		try {
			await this.apiClient.stream(
				apiKey,
				{
					model: apiModelId,
					max_tokens: maxTokens,
					messages: apiMessages,
					system: request.systemPrompt,
				},
				(event: AnthropicStreamEvent) => {
					if (cancellation.isCancellationRequested) {
						return;
					}

					if (event.type === 'content_block_delta') {
						const delta = event as AnthropicStreamEvent & { delta?: { text?: string } };
						if (delta.delta?.text) {
							fullContent += delta.delta.text;
							this._onDidReceiveStreamEvent.fire({
								type: 'text_delta',
								text: delta.delta.text,
							});
						}
					} else if (event.type === 'message_delta') {
						const msgDelta = event as AnthropicStreamEvent & { usage?: { output_tokens?: number }; delta?: { stop_reason?: string } };
						if (msgDelta.usage?.output_tokens != null) {
							outputTokens = msgDelta.usage.output_tokens;
						}
						if (msgDelta.delta?.stop_reason) {
							stopReason = msgDelta.delta.stop_reason;
						}
					} else if (event.type === 'message_start') {
						const msgStart = event as AnthropicStreamEvent & { message?: { usage?: { input_tokens?: number } } };
						if (msgStart.message?.usage?.input_tokens != null) {
							inputTokens = msgStart.message.usage.input_tokens;
						}
					}
				},
				abortController.signal,
			);
		} catch (e) {
			if (abortController.signal.aborted) {
				stopReason = 'cancelled';
			} else {
				const errorText = e instanceof Error ? e.message : String(e);
				this.logService.error(`[Nyrve] API error: ${errorText}`);
				this._onDidReceiveStreamEvent.fire({ type: 'error', error: errorText });
				throw e;
			}
		} finally {
			cancelListener.dispose();
			this._onDidReceiveStreamEvent.fire({ type: 'message_stop' });
		}

		return { content: fullContent, inputTokens, outputTokens, stopReason };
	}

	private async _sendNonStreaming(
		apiKey: string,
		apiModelId: string,
		request: NyrveAgentRequest,
		maxTokens: number,
	): Promise<Omit<NyrveAgentResponse, 'model'>> {
		const apiMessages = request.messages.map(m => ({
			role: m.role,
			content: m.content,
		}));

		try {
			const message = await this.apiClient.createMessage(apiKey, {
				model: apiModelId,
				max_tokens: maxTokens,
				messages: apiMessages,
				system: request.systemPrompt,
			});

			const content = message.content
				.filter(block => block.type === 'text')
				.map(block => block.text ?? '')
				.join('');
			const inputTokens = message.usage?.input_tokens ?? 0;
			const outputTokens = message.usage?.output_tokens ?? 0;
			const stopReason = message.stop_reason ?? 'end_turn';

			this._onDidReceiveStreamEvent.fire({ type: 'message_start' });
			this._onDidReceiveStreamEvent.fire({ type: 'text_delta', text: content });
			this._onDidReceiveStreamEvent.fire({ type: 'message_stop' });

			return { content, inputTokens, outputTokens, stopReason };
		} catch (e) {
			const errorText = e instanceof Error ? e.message : String(e);
			this.logService.error(`[Nyrve] API error: ${errorText}`);
			this._onDidReceiveStreamEvent.fire({ type: 'error', error: errorText });
			throw e;
		}
	}
}

registerSingleton(INyrveAgentEngine, NyrveAgentEngine, InstantiationType.Delayed);
