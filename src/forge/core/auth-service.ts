/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from '../../vs/base/common/event.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { ISecretStorageService } from '../../vs/platform/secrets/common/secrets.js';
import { IForgeApiClient } from './api-client.js';

// --- Constants ---

const ANTHROPIC_API_KEY_SECRET = 'forge.anthropic.apiKey';
const KEY_PREFIX = 'sk-ant-';
const MIN_KEY_LENGTH = 40;
const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// --- Types ---

export type ConnectionStatus = 'connected' | 'disconnected' | 'no-key' | 'connecting';

export interface ApiKeyValidationResult {
	readonly valid: boolean;
	readonly error?: 'invalid_key' | 'no_permission' | 'rate_limited' | 'network_error' | 'invalid_format';
	readonly message?: string;
}

export interface ClaudeModel {
	readonly id: string;
	readonly name: string;
	readonly contextWindow: number;
	readonly tier: 'opus' | 'sonnet' | 'haiku';
}

// --- Service Interface ---

export const IForgeAuthService = createDecorator<IForgeAuthService>('forgeAuthService');

export interface IForgeAuthService {
	readonly _serviceBrand: undefined;

	// Key management
	getApiKey(): Promise<string | undefined>;
	storeApiKey(key: string): Promise<void>;
	deleteApiKey(): Promise<void>;
	hasApiKey(): Promise<boolean>;

	// Validation
	validateApiKey(key: string): Promise<ApiKeyValidationResult>;

	// Model discovery
	getAvailableModels(): Promise<readonly ClaudeModel[]>;
	refreshModels(): Promise<void>;

	// Connection status
	getConnectionStatus(): ConnectionStatus;
	readonly onConnectionStatusChanged: Event<ConnectionStatus>;

	// Health check
	checkConnection(): Promise<boolean>;
}

// --- Service Implementation ---

/** Default model list when API discovery is unavailable. */
const DEFAULT_MODELS: ClaudeModel[] = [
	{ id: 'claude-opus-4-6', name: 'Claude Opus 4.6', contextWindow: 200000, tier: 'opus' },
	{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200000, tier: 'sonnet' },
	{ id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', contextWindow: 200000, tier: 'haiku' },
];

function classifyModelTier(id: string): 'opus' | 'sonnet' | 'haiku' {
	if (id.includes('opus')) {
		return 'opus';
	}
	if (id.includes('haiku')) {
		return 'haiku';
	}
	return 'sonnet';
}

function estimateContextWindow(id: string): number {
	// All current Claude models support 200K context
	if (id.includes('haiku')) {
		return 200000;
	}
	return 200000;
}

export class ForgeAuthService extends Disposable implements IForgeAuthService {
	declare readonly _serviceBrand: undefined;

	private readonly _onConnectionStatusChanged = this._register(new Emitter<ConnectionStatus>());
	readonly onConnectionStatusChanged: Event<ConnectionStatus> = this._onConnectionStatusChanged.event;

	private _connectionStatus: ConnectionStatus = 'no-key';
	private _cachedModels: ClaudeModel[] | undefined;
	private _modelsCachedAt = 0;
	private _healthCheckTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IForgeApiClient private readonly apiClient: IForgeApiClient,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		// Initialize connection status
		this._initializeStatus();
	}

	// --- Key Management ---

	async getApiKey(): Promise<string | undefined> {
		try {
			return await this.secretStorageService.get(ANTHROPIC_API_KEY_SECRET) ?? undefined;
		} catch {
			return undefined;
		}
	}

	async storeApiKey(key: string): Promise<void> {
		await this.secretStorageService.set(ANTHROPIC_API_KEY_SECRET, key);
		this.logService.info('[Forge] Anthropic API key stored in OS keychain');

		// Validate and update status
		this._setStatus('connecting');
		const result = await this.validateApiKey(key);
		if (result.valid) {
			this._setStatus('connected');
			this._startHealthCheck();
			await this.refreshModels();
		} else {
			this._setStatus('disconnected');
		}
	}

	async deleteApiKey(): Promise<void> {
		await this.secretStorageService.delete(ANTHROPIC_API_KEY_SECRET);
		this._stopHealthCheck();
		this._cachedModels = undefined;
		this._setStatus('no-key');
		this.logService.info('[Forge] Anthropic API key removed');
	}

	async hasApiKey(): Promise<boolean> {
		const key = await this.getApiKey();
		return !!key;
	}

	// --- Validation ---

	async validateApiKey(key: string): Promise<ApiKeyValidationResult> {
		// Format validation
		if (!key.startsWith(KEY_PREFIX) || key.length < MIN_KEY_LENGTH) {
			return {
				valid: false,
				error: 'invalid_format',
				message: `API key must start with "${KEY_PREFIX}" and be at least ${MIN_KEY_LENGTH} characters`,
			};
		}

		// Live validation via lightweight Haiku call
		const result = await this.apiClient.validateKey(key);
		if (result.valid) {
			return { valid: true };
		}

		const messages: Record<string, string> = {
			'invalid_key': 'Invalid API key. Please check your key and try again.',
			'no_permission': 'This API key does not have permission to access Claude. Check your Anthropic account.',
			'rate_limited': 'Rate limited. Your key is valid, but you are being rate limited. Try again shortly.',
			'network_error': 'Cannot reach the Anthropic API. Check your network connection.',
		};

		return {
			valid: false,
			error: result.error as ApiKeyValidationResult['error'],
			message: messages[result.error ?? ''] ?? `Validation failed: ${result.error}`,
		};
	}

	// --- Model Discovery ---

	async getAvailableModels(): Promise<readonly ClaudeModel[]> {
		// Return cached if fresh
		if (this._cachedModels && (Date.now() - this._modelsCachedAt) < MODEL_CACHE_TTL_MS) {
			return this._cachedModels;
		}

		const key = await this.getApiKey();
		if (!key) {
			return DEFAULT_MODELS;
		}

		const apiModels = await this.apiClient.listModels(key);
		if (apiModels.length === 0) {
			return this._cachedModels ?? DEFAULT_MODELS;
		}

		// Filter to Claude models only and map to our format
		this._cachedModels = apiModels
			.filter(m => m.id.startsWith('claude-'))
			.map(m => ({
				id: m.id,
				name: m.displayName || m.id,
				contextWindow: estimateContextWindow(m.id),
				tier: classifyModelTier(m.id),
			}));

		this._modelsCachedAt = Date.now();
		this.logService.info(`[Forge] Discovered ${this._cachedModels.length} Claude models`);

		return this._cachedModels;
	}

	async refreshModels(): Promise<void> {
		this._modelsCachedAt = 0; // Invalidate cache
		await this.getAvailableModels();
	}

	// --- Connection Status ---

	getConnectionStatus(): ConnectionStatus {
		return this._connectionStatus;
	}

	async checkConnection(): Promise<boolean> {
		const key = await this.getApiKey();
		if (!key) {
			this._setStatus('no-key');
			return false;
		}

		this._setStatus('connecting');
		const result = await this.validateApiKey(key);
		if (result.valid || result.error === 'rate_limited') {
			// Rate limited means the key is valid, just throttled
			this._setStatus('connected');
			return true;
		}

		this._setStatus('disconnected');
		return false;
	}

	// --- Private ---

	private async _initializeStatus(): Promise<void> {
		const hasKey = await this.hasApiKey();
		if (!hasKey) {
			this._setStatus('no-key');
			return;
		}

		// Have a key — check connection in background
		this._setStatus('connecting');
		const connected = await this.checkConnection();
		if (connected) {
			this._startHealthCheck();
		}
	}

	private _setStatus(status: ConnectionStatus): void {
		if (this._connectionStatus !== status) {
			this._connectionStatus = status;
			this._onConnectionStatusChanged.fire(status);
		}
	}

	private _startHealthCheck(): void {
		this._stopHealthCheck();
		this._healthCheckTimer = setInterval(() => {
			this.checkConnection().catch(e => {
				this.logService.trace(`[Forge] Health check failed: ${e}`);
			});
		}, HEALTH_CHECK_INTERVAL_MS);
	}

	private _stopHealthCheck(): void {
		if (this._healthCheckTimer) {
			clearInterval(this._healthCheckTimer);
			this._healthCheckTimer = undefined;
		}
	}

	override dispose(): void {
		this._stopHealthCheck();
		super.dispose();
	}
}

registerSingleton(IForgeAuthService, ForgeAuthService, InstantiationType.Delayed);
