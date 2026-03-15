/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { IForgeAgentService } from '../agent/agent-service.js';
import { ForgeAgentResponse, ForgeMessage } from '../agent/agent-engine.js';
import { IForgeBackgroundAgent, BackgroundSuggestion } from '../agent/background-agent.js';
import { IForgeIndexManager } from '../indexer/index-manager.js';
import { ForgeSymbol } from '../indexer/symbol-extractor.js';
import { IForgeMemoryEngine, MemoryEntry } from '../memory/memory-engine.js';
import { IForgeTaskQueue, Task, TaskCreateParams } from '../ui/task-queue/task-panel.js';
import { ContextBlock } from '../context/context-builder.js';

// --- Public API Types ---

/**
 * The public API surface exposed to third-party VS Code extensions
 * via `vscode.extensions.getExtension('forge.forge-ide')?.exports`.
 */
export interface ForgeExtensionAPI {
	readonly agent: ForgeAgentAPI;
	readonly index: ForgeIndexAPI;
	readonly memory: ForgeMemoryAPI;
	readonly tasks: ForgeTasksAPI;
}

export interface ForgeAgentAPI {
	/** Send a message to the agent and get a response. */
	sendMessage(message: string, context?: ContextBlock[]): Promise<ForgeAgentResponse>;

	/** Subscribe to background agent suggestions. */
	onSuggestion(callback: (suggestion: BackgroundSuggestion) => void): IDisposable;

	/** Register a custom context provider that supplies additional context. */
	registerContextProvider(provider: ForgeContextProvider): IDisposable;

	/** Get the current conversation messages. */
	getMessages(): readonly ForgeMessage[];
}

export interface ForgeIndexAPI {
	/** Search the codebase index by query. */
	searchFiles(query: string, maxResults?: number): Promise<readonly string[]>;

	/** Get a symbol by name. */
	getSymbol(name: string): Promise<ForgeSymbol | undefined>;

	/** Get all symbols in a file. */
	getFileSymbols(filePath: string): Promise<readonly ForgeSymbol[]>;
}

export interface ForgeMemoryAPI {
	/** Search memories by query text. */
	search(query: string, topK?: number): Promise<readonly MemoryEntry[]>;

	/** Add a new memory entry. */
	add(content: string, tags?: string[]): Promise<string>;

	/** Remove a memory entry by ID. */
	remove(id: string): Promise<void>;
}

export interface ForgeTasksAPI {
	/** Create a new task in the queue. */
	create(params: TaskCreateParams): Promise<Task>;

	/** List all tasks, optionally filtered. */
	list(): Promise<readonly Task[]>;

	/** Cancel a task. */
	cancel(id: string): Promise<void>;

	/** Subscribe to task status changes. */
	onStatusChange(callback: (task: Task) => void): IDisposable;
}

/** Custom context provider that extensions can register. */
export interface ForgeContextProvider {
	readonly id: string;
	readonly label: string;
	provideContext(query: string): Promise<ContextBlock | undefined>;
}

// --- Service Interface ---

export const IForgeExtensionAPI = createDecorator<IForgeExtensionAPI>('forgeExtensionAPI');

export interface IForgeExtensionAPI {
	readonly _serviceBrand: undefined;

	/** Get the public API object for extensions. */
	getAPI(): ForgeExtensionAPI;

	/** Register a custom context provider. */
	registerContextProvider(provider: ForgeContextProvider): IDisposable;

	/** Get all registered context providers. */
	getContextProviders(): readonly ForgeContextProvider[];
}

// --- Service Implementation ---

export class ForgeExtensionAPIService extends Disposable implements IForgeExtensionAPI {
	declare readonly _serviceBrand: undefined;

	private readonly _contextProviders = new Map<string, ForgeContextProvider>();
	private _api: ForgeExtensionAPI | undefined;

	constructor(
		@IForgeAgentService private readonly agentService: IForgeAgentService,
		@IForgeBackgroundAgent private readonly backgroundAgent: IForgeBackgroundAgent,
		@IForgeIndexManager private readonly indexManager: IForgeIndexManager,
		@IForgeMemoryEngine private readonly memoryEngine: IForgeMemoryEngine,
		@IForgeTaskQueue private readonly taskQueue: IForgeTaskQueue,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	getAPI(): ForgeExtensionAPI {
		if (!this._api) {
			this._api = this._createAPI();
		}
		return this._api;
	}

	registerContextProvider(provider: ForgeContextProvider): IDisposable {
		if (this._contextProviders.has(provider.id)) {
			this.logService.warn(`[Forge] Context provider '${provider.id}' already registered, replacing.`);
		}
		this._contextProviders.set(provider.id, provider);
		this.logService.info(`[Forge] Registered context provider: ${provider.id}`);

		return {
			dispose: () => {
				this._contextProviders.delete(provider.id);
			}
		};
	}

	getContextProviders(): readonly ForgeContextProvider[] {
		return [...this._contextProviders.values()];
	}

	private _createAPI(): ForgeExtensionAPI {
		const agentService = this.agentService;
		const backgroundAgent = this.backgroundAgent;
		const indexManager = this.indexManager;
		const memoryEngine = this.memoryEngine;
		const taskQueue = this.taskQueue;
		const self = this;

		return {
			agent: {
				async sendMessage(message: string): Promise<ForgeAgentResponse> {
					return agentService.sendUserMessage(message);
				},
				onSuggestion(callback: (suggestion: BackgroundSuggestion) => void): IDisposable {
					return backgroundAgent.onDidAddSuggestion(callback);
				},
				registerContextProvider(provider: ForgeContextProvider): IDisposable {
					return self.registerContextProvider(provider);
				},
				getMessages(): readonly ForgeMessage[] {
					return agentService.getConversation().messages;
				},
			},
			index: {
				async searchFiles(query: string, maxResults: number = 20): Promise<readonly string[]> {
					const results = indexManager.searchFiles(query);
					return results.slice(0, maxResults);
				},
				async getSymbol(name: string): Promise<ForgeSymbol | undefined> {
					const symbols = indexManager.getFileSymbols(''); // search across all
					return symbols.find(s => s.name === name);
				},
				async getFileSymbols(filePath: string): Promise<readonly ForgeSymbol[]> {
					return indexManager.getFileSymbols(filePath);
				},
			},
			memory: {
				async search(query: string, topK: number = 10): Promise<readonly MemoryEntry[]> {
					return memoryEngine.searchByContent(query).slice(0, topK);
				},
				async add(content: string, tags?: string[]): Promise<string> {
					const entry = memoryEngine.addMemory({
						type: 0 as never, // Will be classified
						content,
						embedding: [],
						source: 0 as never,
						tags: tags ?? [],
						confidence: 0.8,
						userVerified: false,
					});
					return entry.id;
				},
				async remove(id: string): Promise<void> {
					memoryEngine.deleteMemory(id);
				},
			},
			tasks: {
				async create(params: TaskCreateParams): Promise<Task> {
					return taskQueue.addTask(params);
				},
				async list(): Promise<readonly Task[]> {
					return taskQueue.getTasks();
				},
				async cancel(id: string): Promise<void> {
					taskQueue.cancelTask(id);
				},
				onStatusChange(callback: (task: Task) => void): IDisposable {
					return taskQueue.onDidUpdateTask(callback);
				},
			},
		};
	}
}

registerSingleton(IForgeExtensionAPI, ForgeExtensionAPIService, InstantiationType.Delayed);
