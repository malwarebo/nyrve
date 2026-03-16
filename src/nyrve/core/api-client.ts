/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';

// --- Constants ---

const ANTHROPIC_API_BASE = 'https://api.anthropic.com';
const ANTHROPIC_API_VERSION = '2023-06-01';
const USER_AGENT = 'Nyrve-IDE/1.0';

const MAX_RETRIES = 6;
const INITIAL_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;

// --- Types ---

export interface AnthropicRequestOptions {
	readonly method: 'GET' | 'POST';
	readonly path: string;
	readonly body?: unknown;
	readonly stream?: boolean;
	readonly signal?: AbortSignal;
}

export interface AnthropicStreamEvent {
	readonly type: string;
	readonly [key: string]: unknown;
}

// --- Service Interface ---

export const INyrveApiClient = createDecorator<INyrveApiClient>('nyrveApiClient');

export interface INyrveApiClient {
	readonly _serviceBrand: undefined;

	/** Make a non-streaming API request. */
	request<T>(apiKey: string, options: AnthropicRequestOptions): Promise<T>;

	/** Make a streaming API request, yielding SSE events. */
	stream(apiKey: string, options: AnthropicRequestOptions, onEvent: (event: AnthropicStreamEvent) => void): Promise<void>;

	/** Quick validation: send a minimal Haiku request to check key validity. */
	validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }>;

	/** Fetch available models from the API. */
	listModels(apiKey: string): Promise<AnthropicModel[]>;
}

export interface AnthropicModel {
	readonly id: string;
	readonly displayName: string;
	readonly createdAt: string;
}

// --- Service Implementation ---

export class NyrveApiClient extends Disposable implements INyrveApiClient {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async request<T>(apiKey: string, options: AnthropicRequestOptions): Promise<T> {
		const response = await this._fetchWithRetry(apiKey, options);
		return response.json() as Promise<T>;
	}

	async stream(apiKey: string, options: AnthropicRequestOptions, onEvent: (event: AnthropicStreamEvent) => void): Promise<void> {
		const response = await this._fetchWithRetry(apiKey, {
			...options,
			stream: true,
		});

		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error('No response body for streaming');
		}

		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });

				// Parse SSE events from buffer
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? ''; // Keep incomplete last line

				let currentEventType = '';
				for (const line of lines) {
					if (line.startsWith('event: ')) {
						currentEventType = line.slice(7).trim();
					} else if (line.startsWith('data: ')) {
						const data = line.slice(6);
						if (data === '[DONE]') {
							return;
						}
						try {
							const parsed = JSON.parse(data);
							if (currentEventType) {
								parsed.type = currentEventType;
							}
							onEvent(parsed);
						} catch {
							this.logService.trace(`[Nyrve] SSE parse error: ${data}`);
						}
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
		try {
			const response = await fetch(`${ANTHROPIC_API_BASE}/v1/messages`, {
				method: 'POST',
				headers: this._buildHeaders(apiKey),
				body: JSON.stringify({
					model: 'claude-haiku-4-5-20251001',
					max_tokens: 1,
					messages: [{ role: 'user', content: 'hi' }],
				}),
			});

			if (response.ok) {
				return { valid: true };
			}

			switch (response.status) {
				case 401:
					return { valid: false, error: 'invalid_key' };
				case 403:
					return { valid: false, error: 'no_permission' };
				case 429:
					return { valid: false, error: 'rate_limited' };
				default:
					return { valid: false, error: `http_${response.status}` };
			}
		} catch (e) {
			return { valid: false, error: 'network_error' };
		}
	}

	async listModels(apiKey: string): Promise<AnthropicModel[]> {
		try {
			const response = await fetch(`${ANTHROPIC_API_BASE}/v1/models`, {
				method: 'GET',
				headers: this._buildHeaders(apiKey),
			});

			if (!response.ok) {
				this.logService.warn(`[Nyrve] Failed to list models: ${response.status}`);
				return [];
			}

			const data = await response.json() as { data: Array<{ id: string; display_name: string; created_at: string }> };
			return data.data.map(m => ({
				id: m.id,
				displayName: m.display_name,
				createdAt: m.created_at,
			}));
		} catch (e) {
			this.logService.warn(`[Nyrve] Failed to fetch models: ${e}`);
			return [];
		}
	}

	private async _fetchWithRetry(apiKey: string, options: AnthropicRequestOptions): Promise<Response> {
		const headers = this._buildHeaders(apiKey);
		if (options.stream) {
			headers['Accept'] = 'text/event-stream';
		}

		const url = `${ANTHROPIC_API_BASE}${options.path}`;
		let lastError: Error | undefined;

		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				const response = await fetch(url, {
					method: options.method,
					headers,
					body: options.body ? JSON.stringify(options.body) : undefined,
					signal: options.signal,
				});

				if (response.ok) {
					return response;
				}

				// Only retry on 429 (rate limit) and 529 (overloaded)
				if (response.status === 429 || response.status === 529) {
					if (attempt < MAX_RETRIES) {
						const retryAfter = response.headers.get('retry-after');
						const delayMs = retryAfter
							? parseInt(retryAfter, 10) * 1000
							: Math.min(INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);

						this.logService.trace(`[Nyrve] API rate limited (${response.status}), retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
						await this._sleep(delayMs);
						continue;
					}
				}

				// Non-retryable error
				const errorBody = await response.text().catch(() => '');
				throw new Error(`Anthropic API error ${response.status}: ${errorBody}`);
			} catch (e) {
				if (e instanceof Error && e.name === 'AbortError') {
					throw e; // Don't retry cancellations
				}
				lastError = e instanceof Error ? e : new Error(String(e));
				if (attempt < MAX_RETRIES) {
					const delayMs = Math.min(INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);
					this.logService.trace(`[Nyrve] API request failed, retrying in ${delayMs}ms: ${lastError.message}`);
					await this._sleep(delayMs);
				}
			}
		}

		throw lastError ?? new Error('Max retries exceeded');
	}

	private _buildHeaders(apiKey: string): Record<string, string> {
		return {
			'x-api-key': apiKey,
			'anthropic-version': ANTHROPIC_API_VERSION,
			'content-type': 'application/json',
			'user-agent': USER_AGENT,
		};
	}

	private _sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}

registerSingleton(INyrveApiClient, NyrveApiClient, InstantiationType.Delayed);
