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
		request: NyrveAgentRequest,
		maxTokens: number,
		useStreaming: boolean,
		cancellation: CancellationToken,
	): Promise<Omit<NyrveAgentResponse, 'model'>> {
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
				this.logService.error(`[Nyrve] API error ${response.status}: ${errorText}`);
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
	): Promise<Omit<NyrveAgentResponse, 'model'>> {
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
	): Promise<Omit<NyrveAgentResponse, 'model'>> {
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

registerSingleton(INyrveAgentEngine, NyrveAgentEngine, InstantiationType.Delayed);
