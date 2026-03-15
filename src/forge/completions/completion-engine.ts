/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { IForgeApiClient, AnthropicStreamEvent } from '../core/api-client.js';
import { IForgeAuthService } from '../core/auth-service.js';
import { IForgeModelRouter, ForgeTaskComplexity } from '../agent/model-router.js';
import { IForgeTokenTracker } from '../agent/token-tracker.js';
import { IForgeCompletionCache, CachedCompletion } from './completion-cache.js';
import { IForgeCompletionContext, CompletionRequest, CompletionPrompt } from './completion-context.js';
import { IForgeCompletionTrigger, TriggerKind } from './completion-trigger.js';

// --- Types ---

export interface CompletionResult {
	readonly text: string;
	readonly latencyMs: number;
	readonly cached: boolean;
	readonly model: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly requestId: string;
}

// --- Service Interface ---

export const IForgeCompletionEngine = createDecorator<IForgeCompletionEngine>('forgeCompletionEngine');

export interface IForgeCompletionEngine {
	readonly _serviceBrand: undefined;

	/** Request a completion. Returns undefined if no completion available. */
	complete(triggerKind: TriggerKind): Promise<CompletionResult | undefined>;

	/** Cancel any in-flight completion request. */
	cancel(): void;

	/** Whether a request is currently in-flight. */
	readonly isActive: boolean;
}

// --- Constants ---

const FIRST_TOKEN_TIMEOUT_MS = 500;
const ABSOLUTE_TIMEOUT_MS = 3000;

// --- Implementation ---

export class ForgeCompletionEngine extends Disposable implements IForgeCompletionEngine {
	declare readonly _serviceBrand: undefined;

	private _activeAbort: AbortController | undefined;
	private _isActive = false;

	get isActive(): boolean {
		return this._isActive;
	}

	constructor(
		@IForgeApiClient private readonly apiClient: IForgeApiClient,
		@IForgeAuthService private readonly authService: IForgeAuthService,
		@IForgeModelRouter private readonly modelRouter: IForgeModelRouter,
		@IForgeTokenTracker private readonly tokenTracker: IForgeTokenTracker,
		@IForgeCompletionCache private readonly cache: IForgeCompletionCache,
		@IForgeCompletionContext private readonly context: IForgeCompletionContext,
		@IForgeCompletionTrigger private readonly trigger: IForgeCompletionTrigger,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async complete(triggerKind: TriggerKind): Promise<CompletionResult | undefined> {
		// Cancel any previous in-flight request
		this.cancel();

		const startTime = Date.now();

		// Check connection
		const connectionStatus = this.authService.getConnectionStatus();
		if (connectionStatus !== 'connected') {
			return undefined;
		}

		// Build request from editor state
		const request = this.context.buildRequest(triggerKind);
		if (!request) {
			return undefined;
		}

		// Check cache — exact match
		const cacheResult = this.cache.lookup(request.prefix, request.suffix, request.linesBefore.at(-1) ?? '');
		if (cacheResult.hit && cacheResult.completion) {
			this.logService.trace('[Forge] Completion cache hit');
			return {
				text: cacheResult.completion.text,
				latencyMs: Date.now() - startTime,
				cached: true,
				model: cacheResult.completion.model,
				inputTokens: 0,
				outputTokens: 0,
				requestId: request.requestId,
			};
		}

		// Check cache — prefix match (user typed part of cached completion)
		const prefixResult = this.cache.lookupPrefixMatch(request.prefix, request.suffix, request.linesBefore.at(-1) ?? '');
		if (prefixResult.hit && prefixResult.completion) {
			this.logService.trace('[Forge] Completion cache prefix hit');
			return {
				text: prefixResult.completion.text,
				latencyMs: Date.now() - startTime,
				cached: true,
				model: prefixResult.completion.model,
				inputTokens: 0,
				outputTokens: 0,
				requestId: request.requestId,
			};
		}

		// Build the prompt
		const prompt = this.context.buildPrompt(request);

		// Make API call
		return this._callApi(request, prompt, startTime);
	}

	cancel(): void {
		if (this._activeAbort) {
			this._activeAbort.abort();
			this._activeAbort = undefined;
		}
		this._isActive = false;
	}

	private async _callApi(
		request: CompletionRequest,
		prompt: CompletionPrompt,
		startTime: number,
	): Promise<CompletionResult | undefined> {
		const apiKey = await this.authService.getApiKey();
		if (!apiKey) {
			return undefined;
		}

		const modelId = this.modelRouter.selectModel(ForgeTaskComplexity.Low);
		const apiModelId = this.modelRouter.getApiModelId(modelId);

		const abort = new AbortController();
		this._activeAbort = abort;
		this._isActive = true;

		let completionText = '';
		let inputTokens = 0;
		let outputTokens = 0;
		let firstTokenReceived = false;

		// First-token timeout: if no token arrives in 500ms, cancel
		const firstTokenTimer = setTimeout(() => {
			if (!firstTokenReceived && !abort.signal.aborted) {
				this.logService.trace('[Forge] Completion first-token timeout');
				abort.abort();
			}
		}, FIRST_TOKEN_TIMEOUT_MS);

		// Absolute timeout: 3 seconds total
		const absoluteTimer = setTimeout(() => {
			if (!abort.signal.aborted) {
				this.logService.trace('[Forge] Completion absolute timeout');
				abort.abort();
			}
		}, ABSOLUTE_TIMEOUT_MS);

		try {
			await this.apiClient.stream(
				apiKey,
				{
					method: 'POST',
					path: '/v1/messages',
					body: {
						model: apiModelId,
						max_tokens: 256,
						system: prompt.systemPrompt,
						messages: [{ role: 'user', content: prompt.userPrompt }],
						stream: true,
						temperature: 0,
						stop_sequences: ['\n\n\n', '```'],
					},
					stream: true,
					signal: abort.signal,
				},
				(event: AnthropicStreamEvent) => {
					if (abort.signal.aborted) {
						return;
					}

					if (event.type === 'content_block_delta') {
						const delta = event as AnthropicStreamEvent & { delta?: { text?: string } };
						if (delta.delta?.text) {
							if (!firstTokenReceived) {
								firstTokenReceived = true;
								clearTimeout(firstTokenTimer);
							}
							completionText += delta.delta.text;
						}
					} else if (event.type === 'message_delta') {
						const msgDelta = event as AnthropicStreamEvent & { usage?: { output_tokens?: number } };
						if (msgDelta.usage?.output_tokens) {
							outputTokens = msgDelta.usage.output_tokens;
						}
					} else if (event.type === 'message_start') {
						const msgStart = event as AnthropicStreamEvent & { message?: { usage?: { input_tokens?: number } } };
						if (msgStart.message?.usage?.input_tokens) {
							inputTokens = msgStart.message.usage.input_tokens;
						}
					}
				},
			);
		} catch (e) {
			// Aborted or network error — not an actual failure for the user
			if (abort.signal.aborted) {
				this.logService.trace('[Forge] Completion request cancelled');
				return undefined;
			}

			// Rate limit — tell the trigger service
			if (e instanceof Error && e.message.includes('429')) {
				this.trigger.recordRateLimit();
				// Clear rate limit after 30 seconds
				setTimeout(() => this.trigger.clearRateLimit(), 30_000);
			}

			this.logService.warn('[Forge] Completion API error', e);
			return undefined;
		} finally {
			clearTimeout(firstTokenTimer);
			clearTimeout(absoluteTimer);
			this._activeAbort = undefined;
			this._isActive = false;
		}

		if (!completionText || completionText.trim().length === 0) {
			return undefined;
		}

		const latencyMs = Date.now() - startTime;

		// Track token usage
		this.tokenTracker.recordUsage(modelId, inputTokens, outputTokens);

		// Store in cache
		const lineText = request.linesBefore.at(-1) ?? '';
		const cached: CachedCompletion = {
			text: completionText,
			timestamp: Date.now(),
			model: apiModelId,
			tokens: outputTokens,
		};
		this.cache.store(request.prefix, request.suffix, lineText, cached);

		this.logService.trace(`[Forge] Completion: ${completionText.length} chars in ${latencyMs}ms (${inputTokens}+${outputTokens} tokens)`);

		return {
			text: completionText,
			latencyMs,
			cached: false,
			model: apiModelId,
			inputTokens,
			outputTokens,
			requestId: request.requestId,
		};
	}

	override dispose(): void {
		this.cancel();
		super.dispose();
	}
}

registerSingleton(IForgeCompletionEngine, ForgeCompletionEngine, InstantiationType.Delayed);
