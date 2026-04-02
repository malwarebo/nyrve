/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { AppResourcePath, FileAccess, nodeModulesPath } from '../../vs/base/common/network.js';
import type AnthropicSDK from '@anthropic-ai/sdk';

// --- Constants ---

const MAX_RETRIES = 6;

// --- Types ---

export interface AnthropicMessageParams {
	readonly model: string;
	readonly max_tokens: number;
	readonly messages: ReadonlyArray<{ readonly role: 'user' | 'assistant'; readonly content: string | ReadonlyArray<unknown> }>;
	readonly system?: string;
	readonly temperature?: number;
	readonly stop_sequences?: readonly string[];
}

export interface AnthropicStreamEvent {
	readonly type: string;
	readonly [key: string]: unknown;
}

export interface AnthropicMessageResponse {
	readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
	readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
	readonly stop_reason: string | null;
}

// --- Service Interface ---

export const INyrveApiClient = createDecorator<INyrveApiClient>('nyrveApiClient');

export interface INyrveApiClient {
	readonly _serviceBrand: undefined;

	/**
	 * Make a streaming API request for messages, yielding raw SSE events.
	 *
	 * When `signal` is aborted mid-stream, the method returns normally (no throw).
	 * When `signal` is aborted before the stream connects, the SDK throws an abort error.
	 * Callers should check `signal.aborted` in catch blocks to distinguish cancellation from errors.
	 */
	stream(apiKey: string, params: AnthropicMessageParams, onEvent: (event: AnthropicStreamEvent) => void, signal?: AbortSignal): Promise<void>;

	/** Make a non-streaming messages API request. */
	createMessage(apiKey: string, params: AnthropicMessageParams): Promise<AnthropicMessageResponse>;

	/** Quick validation: send a minimal Haiku request to check key validity. */
	validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }>;

	/** Fetch available models from the API. */
	listModels(apiKey: string): Promise<AnthropicModel[]>;

	/** Evict cached SDK client instances (e.g. after API key change). */
	clearClientCache(): void;

	/** Check if an error is a rate limit error from the Anthropic API. */
	isRateLimitError(error: unknown): boolean;
}

export interface AnthropicModel {
	readonly id: string;
	readonly displayName: string;
	readonly createdAt: string;
}

// --- Service Implementation ---

type AnthropicClient = InstanceType<typeof AnthropicSDK>;

/**
 * Lazily-loaded Anthropic SDK module.
 *
 * The SDK cannot be loaded via bare specifier (`import '@anthropic-ai/sdk'`) in
 * the Electron renderer because it uses browser ESM resolution. Instead we
 * construct a `vscode-file://` URI to the SDK's ESM entry point using VS Code's
 * `FileAccess.asBrowserUri`, then `import()` that full URL. The SDK's internal
 * imports are all relative, so they resolve correctly from that base URL.
 */
let _sdkModule: typeof import('@anthropic-ai/sdk') | undefined;
async function loadSDK(): Promise<typeof import('@anthropic-ai/sdk')> {
	if (!_sdkModule) {
		const sdkPath: AppResourcePath = `${nodeModulesPath}/@anthropic-ai/sdk/index.mjs`;
		const sdkUrl = FileAccess.asBrowserUri(sdkPath).toString(true);
		_sdkModule = await import(/* @vite-ignore */ sdkUrl) as typeof import('@anthropic-ai/sdk');
	}
	return _sdkModule;
}

export class NyrveApiClient extends Disposable implements INyrveApiClient {
	declare readonly _serviceBrand: undefined;

	private readonly _clientCache = new Map<string, AnthropicClient>();

	constructor(
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	private async _getClient(apiKey: string): Promise<AnthropicClient> {
		let client = this._clientCache.get(apiKey);
		if (!client) {
			const { default: Anthropic } = await loadSDK();
			client = new Anthropic({
				apiKey,
				maxRetries: MAX_RETRIES,
				dangerouslyAllowBrowser: true, // Safe: Electron renderer, key from OS keychain
			});
			this._clientCache.set(apiKey, client);
		}
		return client;
	}

	clearClientCache(): void {
		this._clientCache.clear();
	}

	isRateLimitError(error: unknown): boolean {
		// Check by error name/status since the SDK class may not be loaded yet
		if (error && typeof error === 'object' && 'status' in error) {
			return (error as { status: number }).status === 429;
		}
		return false;
	}

	async stream(apiKey: string, params: AnthropicMessageParams, onEvent: (event: AnthropicStreamEvent) => void, signal?: AbortSignal): Promise<void> {
		const client = await this._getClient(apiKey);

		const sdkParams: AnthropicSDK.MessageCreateParamsStreaming = {
			model: params.model,
			max_tokens: params.max_tokens,
			messages: params.messages as AnthropicSDK.MessageParam[],
			stream: true,
		};
		if (params.system !== undefined) {
			sdkParams.system = params.system;
		}
		if (params.temperature !== undefined) {
			sdkParams.temperature = params.temperature;
		}
		if (params.stop_sequences !== undefined) {
			sdkParams.stop_sequences = params.stop_sequences as string[];
		}

		const response = await client.messages.create(sdkParams, { signal });

		// The response is a Stream<RawMessageStreamEvent> (async iterable)
		const stream = response as AsyncIterable<AnthropicSDK.RawMessageStreamEvent>;
		for await (const event of stream) {
			if (signal?.aborted) {
				break;
			}
			onEvent(event as unknown as AnthropicStreamEvent);
		}
	}

	async createMessage(apiKey: string, params: AnthropicMessageParams): Promise<AnthropicMessageResponse> {
		const client = await this._getClient(apiKey);

		const sdkParams: AnthropicSDK.MessageCreateParamsNonStreaming = {
			model: params.model,
			max_tokens: params.max_tokens,
			messages: params.messages as AnthropicSDK.MessageParam[],
		};
		if (params.system !== undefined) {
			sdkParams.system = params.system;
		}
		if (params.temperature !== undefined) {
			sdkParams.temperature = params.temperature;
		}
		if (params.stop_sequences !== undefined) {
			sdkParams.stop_sequences = params.stop_sequences as string[];
		}

		const message = await client.messages.create(sdkParams);
		return {
			content: message.content.map(block => ({
				type: block.type,
				text: 'text' in block ? block.text : undefined,
			})),
			usage: message.usage,
			stop_reason: message.stop_reason,
		};
	}

	async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
		try {
			const { default: Anthropic } = await loadSDK();
			// Use a fresh client for validation (don't cache a potentially-bad key)
			const client = new Anthropic({
				apiKey,
				maxRetries: 0,
				dangerouslyAllowBrowser: true, // Safe: Electron renderer, key from OS keychain
			});
			await client.messages.create({
				model: 'claude-haiku-4-5-20251001',
				max_tokens: 1,
				messages: [{ role: 'user', content: 'hi' }],
			});
			return { valid: true };
		} catch (e) {
			return this._classifyValidationError(e);
		}
	}

	private async _classifyValidationError(e: unknown): Promise<{ valid: boolean; error: string }> {
		this.logService.error(`[Nyrve] API validation error:`, e);
		const { default: Anthropic } = await loadSDK();
		if (e instanceof Anthropic.AuthenticationError) {
			return { valid: false, error: 'invalid_key' };
		}
		if (e instanceof Anthropic.PermissionDeniedError) {
			return { valid: false, error: 'no_permission' };
		}
		if (e instanceof Anthropic.RateLimitError) {
			return { valid: false, error: 'rate_limited' };
		}
		if (e instanceof Anthropic.APIConnectionError) {
			return { valid: false, error: 'network_error' };
		}
		if (e instanceof Anthropic.APIError) {
			return { valid: false, error: `http_${e.status}` };
		}
		// Log unrecognized errors for debugging
		const errorMsg = e instanceof Error ? e.message : String(e);
		this.logService.error(`[Nyrve] Unrecognized validation error: ${errorMsg}`);
		return { valid: false, error: 'network_error' };
	}

	async listModels(apiKey: string): Promise<AnthropicModel[]> {
		try {
			const client = await this._getClient(apiKey);
			const page = await client.models.list();
			const models: AnthropicModel[] = [];
			for (const model of page.data) {
				models.push({
					id: model.id,
					displayName: model.display_name,
					createdAt: model.created_at,
				});
			}
			return models;
		} catch (e) {
			this.logService.warn(`[Nyrve] Failed to fetch models: ${e}`);
			return [];
		}
	}

	override dispose(): void {
		this._clientCache.clear();
		super.dispose();
	}
}

registerSingleton(INyrveApiClient, NyrveApiClient, InstantiationType.Delayed);
