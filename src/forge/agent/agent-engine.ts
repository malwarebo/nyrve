/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../vs/base/common/cancellation.js';
import { Emitter, Event } from '../../vs/base/common/event.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { ForgeModelId, IForgeConfigService } from '../core/config.js';
import { IForgeModelRouter } from './model-router.js';
import { IForgeTokenTracker } from './token-tracker.js';

// --- Types ---

export interface ForgeMessage {
	readonly role: 'user' | 'assistant';
	readonly content: string;
	readonly timestamp: number;
	readonly model?: ForgeModelId;
	readonly tokenUsage?: { input: number; output: number };
}

export interface ForgeStreamEvent {
	readonly type: 'text_delta' | 'message_start' | 'message_stop' | 'error';
	readonly text?: string;
	readonly error?: string;
}

export interface ForgeAgentRequest {
	readonly messages: ForgeMessage[];
	readonly model?: ForgeModelId;
	readonly systemPrompt?: string;
	readonly maxTokens?: number;
}

export interface ForgeAgentResponse {
	readonly content: string;
	readonly model: ForgeModelId;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly stopReason: string;
}

// --- Service Interface ---

export const IForgeAgentEngine = createDecorator<IForgeAgentEngine>('forgeAgentEngine');

export interface IForgeAgentEngine {
	readonly _serviceBrand: undefined;

	/** Fires on each streaming token delta. */
	readonly onDidReceiveStreamEvent: Event<ForgeStreamEvent>;

	/**
	 * Send a message to the Claude API and stream the response.
	 * Returns the complete response when streaming finishes.
	 */
	sendMessage(request: ForgeAgentRequest, cancellation: CancellationToken): Promise<ForgeAgentResponse>;

	/** Check if the engine is currently processing a request. */
	isProcessing(): boolean;
}

// --- Service Implementation ---

export class ForgeAgentEngine extends Disposable implements IForgeAgentEngine {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidReceiveStreamEvent = this._register(new Emitter<ForgeStreamEvent>());
	readonly onDidReceiveStreamEvent: Event<ForgeStreamEvent> = this._onDidReceiveStreamEvent.event;

	private _isProcessing = false;

	constructor(
		@IForgeConfigService private readonly configService: IForgeConfigService,
		@IForgeModelRouter private readonly modelRouter: IForgeModelRouter,
		@IForgeTokenTracker private readonly tokenTracker: IForgeTokenTracker,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	isProcessing(): boolean {
		return this._isProcessing;
	}

	async sendMessage(request: ForgeAgentRequest, cancellation: CancellationToken): Promise<ForgeAgentResponse> {
		const apiKey = await this.configService.getApiKey();
		if (!apiKey) {
			throw new Error('Anthropic API key not configured. Set it in Forge settings.');
		}

		const model = request.model ?? this.modelRouter.getChatModel();
		const apiModelId = this.modelRouter.getApiModelId(model);
		const maxTokens = request.maxTokens ?? this.configService.getMaxTokensPerRequest();
		const useStreaming = this.configService.isStreamingEnabled();

		this._isProcessing = true;
		this.logService.info(`[Forge] Sending request to ${apiModelId} (streaming=${useStreaming})`);

		try {
			const response = await this._callAnthropicApi(apiKey, apiModelId, request, maxTokens, useStreaming, cancellation);
			this.tokenTracker.recordUsage(model, response.inputTokens, response.outputTokens);
			return { ...response, model };
		} finally {
			this._isProcessing = false;
		}
	}

	private async _callAnthropicApi(
		apiKey: string,
		apiModelId: string,
		request: ForgeAgentRequest,
		maxTokens: number,
		useStreaming: boolean,
		cancellation: CancellationToken,
	): Promise<Omit<ForgeAgentResponse, 'model'>> {
		const apiMessages = request.messages.map(m => ({
			role: m.role,
			content: m.content,
		}));

		const body: Record<string, unknown> = {
			model: apiModelId,
			max_tokens: maxTokens,
			messages: apiMessages,
		};
		if (request.systemPrompt) {
			body.system = request.systemPrompt;
		}
		if (useStreaming) {
			body.stream = true;
		}

		const abortController = new AbortController();
		const cancelListener = cancellation.onCancellationRequested(() => {
			abortController.abort();
		});

		try {
			const response = await fetch('https://api.anthropic.com/v1/messages', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': apiKey,
					'anthropic-version': '2023-06-01',
				},
				body: JSON.stringify(body),
				signal: abortController.signal,
			});

			if (!response.ok) {
				const errorText = await response.text();
				this.logService.error(`[Forge] API error ${response.status}: ${errorText}`);
				this._onDidReceiveStreamEvent.fire({ type: 'error', error: `API error ${response.status}: ${errorText}` });
				throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
			}

			if (useStreaming && response.body) {
				return this._handleStreamResponse(response.body, cancellation);
			} else {
				return this._handleJsonResponse(response);
			}
		} finally {
			cancelListener.dispose();
		}
	}

	private async _handleStreamResponse(
		body: ReadableStream<Uint8Array>,
		cancellation: CancellationToken,
	): Promise<Omit<ForgeAgentResponse, 'model'>> {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let fullContent = '';
		let inputTokens = 0;
		let outputTokens = 0;
		let stopReason = 'end_turn';
		let buffer = '';

		this._onDidReceiveStreamEvent.fire({ type: 'message_start' });

		try {
			while (true) {
				if (cancellation.isCancellationRequested) {
					reader.cancel();
					stopReason = 'cancelled';
					break;
				}

				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';

				for (const line of lines) {
					if (!line.startsWith('data: ')) {
						continue;
					}
					const data = line.slice(6).trim();
					if (data === '[DONE]') {
						continue;
					}

					try {
						const event = JSON.parse(data);
						if (event.type === 'content_block_delta' && event.delta?.text) {
							fullContent += event.delta.text;
							this._onDidReceiveStreamEvent.fire({
								type: 'text_delta',
								text: event.delta.text,
							});
						} else if (event.type === 'message_delta') {
							if (event.usage?.output_tokens) {
								outputTokens = event.usage.output_tokens;
							}
							if (event.delta?.stop_reason) {
								stopReason = event.delta.stop_reason;
							}
						} else if (event.type === 'message_start' && event.message?.usage) {
							inputTokens = event.message.usage.input_tokens ?? 0;
						}
					} catch {
						// Skip malformed JSON lines
					}
				}
			}
		} finally {
			this._onDidReceiveStreamEvent.fire({ type: 'message_stop' });
		}

		return { content: fullContent, inputTokens, outputTokens, stopReason };
	}

	private async _handleJsonResponse(
		response: Response,
	): Promise<Omit<ForgeAgentResponse, 'model'>> {
		const json = await response.json();
		const content = json.content?.map((block: { text?: string }) => block.text ?? '').join('') ?? '';
		const inputTokens = json.usage?.input_tokens ?? 0;
		const outputTokens = json.usage?.output_tokens ?? 0;
		const stopReason = json.stop_reason ?? 'end_turn';

		this._onDidReceiveStreamEvent.fire({ type: 'message_start' });
		this._onDidReceiveStreamEvent.fire({ type: 'text_delta', text: content });
		this._onDidReceiveStreamEvent.fire({ type: 'message_stop' });

		return { content, inputTokens, outputTokens, stopReason };
	}
}

registerSingleton(IForgeAgentEngine, ForgeAgentEngine, InstantiationType.Delayed);
