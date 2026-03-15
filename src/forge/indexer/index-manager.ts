/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../vs/base/common/uri.js';
import { Event, Emitter } from '../../vs/base/common/event.js';
import { Disposable, DisposableStore } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { IFileService } from '../../vs/platform/files/common/files.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../vs/platform/workspace/common/workspace.js';
import { IForgeIgnoreService } from './forgeignore.js';
import { ForgeSymbol, IForgeSymbolExtractor } from './symbol-extractor.js';

// --- Types ---

export interface FileIndexEntry {
	readonly filePath: string;
	readonly language: string | undefined;
	readonly lastModified: number;
	readonly contentHash: string;
	readonly symbols: readonly ForgeSymbol[];
	readonly lineCount: number;
	readonly fileSize: number;
}

export interface IndexSearchResult {
	readonly filePath: string;
	readonly lineStart: number;
	readonly lineEnd: number;
	readonly content: string;
	readonly relevanceScore: number;
	readonly reason: 'symbol_match' | 'path_match' | 'content_match';
}

export interface IndexStats {
	readonly totalFiles: number;
	readonly totalSymbols: number;
	readonly isIndexing: boolean;
	readonly lastIndexedAt: number | undefined;
}

export const enum ForgeIndexState {
	Idle = 'idle',
	Indexing = 'indexing',
	Ready = 'ready',
	Error = 'error',
}

// --- Service Interface ---

export const IForgeIndexManager = createDecorator<IForgeIndexManager>('forgeIndexManager');

export interface IForgeIndexManager {
	readonly _serviceBrand: undefined;

	/** Fires when indexing state changes. */
	readonly onDidChangeState: Event<ForgeIndexState>;

	/** Fires when indexing progress updates. */
	readonly onDidUpdateProgress: Event<{ indexed: number; total: number }>;

	/** Get the current index state. */
	readonly state: ForgeIndexState;

	/** Start or restart a full index of the workspace. */
	buildIndex(): Promise<void>;

	/** Incrementally update the index for changed files. */
	updateFile(filePath: string): Promise<void>;

	/** Remove a file from the index. */
	removeFile(filePath: string): void;

	/** Search the index by symbol name (exact or fuzzy). */
	searchSymbols(query: string, maxResults?: number): readonly IndexSearchResult[];

	/** Search the index by file path (fuzzy). */
	searchFiles(query: string, maxResults?: number): readonly string[];

	/** Get all symbols in a file. */
	getFileSymbols(filePath: string): readonly ForgeSymbol[];

	/** Get the full index entry for a file. */
	getFileEntry(filePath: string): FileIndexEntry | undefined;

	/** Get index statistics. */
	getStats(): IndexStats;
}

// --- Service Implementation ---

export class ForgeIndexManager extends Disposable implements IForgeIndexManager {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<ForgeIndexState>());
	readonly onDidChangeState: Event<ForgeIndexState> = this._onDidChangeState.event;

	private readonly _onDidUpdateProgress = this._register(new Emitter<{ indexed: number; total: number }>());
	readonly onDidUpdateProgress: Event<{ indexed: number; total: number }> = this._onDidUpdateProgress.event;

	private _state: ForgeIndexState = ForgeIndexState.Idle;
	private readonly _index = new Map<string, FileIndexEntry>();
	private readonly _symbolIndex = new Map<string, ForgeSymbol[]>(); // symbol name → occurrences
	private readonly _watcherDisposables = this._register(new DisposableStore());

	get state(): ForgeIndexState {
		return this._state;
	}

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IForgeIgnoreService private readonly ignoreService: IForgeIgnoreService,
		@IForgeSymbolExtractor private readonly symbolExtractor: IForgeSymbolExtractor,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		// Watch for file changes in workspace
		this._setupFileWatcher();
	}

	async buildIndex(): Promise<void> {
		const enabled = this.configurationService.getValue<boolean>('forge.indexer.enabled') ?? true;
		if (!enabled) {
			return;
		}

		this._setState(ForgeIndexState.Indexing);
		await this.ignoreService.reload();

		const workspace = this.workspaceService.getWorkspace();
		const projectRoot = workspace.folders[0]?.uri;
		if (!projectRoot) {
			this._setState(ForgeIndexState.Ready);
			return;
		}

		try {
			const maxFiles = this.configurationService.getValue<number>('forge.indexer.maxProjectFiles') ?? 50000;
			const files = await this._collectFiles(projectRoot, maxFiles);
			const total = files.length;

			this.logService.info(`[Forge] Starting index build: ${total} files`);

			let indexed = 0;
			for (const fileUri of files) {
				const filePath = fileUri.fsPath;

				try {
					await this._indexFile(filePath, fileUri);
				} catch (e) {
					this.logService.warn(`[Forge] Failed to index ${filePath}: ${e}`);
				}

				indexed++;
				if (indexed % 100 === 0) {
					this._onDidUpdateProgress.fire({ indexed, total });
				}
			}

			this._onDidUpdateProgress.fire({ indexed: total, total });
			this._setState(ForgeIndexState.Ready);
			this.logService.info(`[Forge] Index build complete: ${this._index.size} files, ${this._countTotalSymbols()} symbols`);
		} catch (e) {
			this.logService.error(`[Forge] Index build failed: ${e}`);
			this._setState(ForgeIndexState.Error);
		}
	}

	async updateFile(filePath: string): Promise<void> {
		if (this.ignoreService.isIgnored(filePath)) {
			return;
		}

		try {
			const uri = URI.file(filePath);
			await this._indexFile(filePath, uri);
			this.logService.trace(`[Forge] Updated index for ${filePath}`);
		} catch (e) {
			this.logService.warn(`[Forge] Failed to update index for ${filePath}: ${e}`);
		}
	}

	removeFile(filePath: string): void {
		const entry = this._index.get(filePath);
		if (entry) {
			// Remove symbols from symbol index
			for (const sym of entry.symbols) {
				const occurrences = this._symbolIndex.get(sym.name.toLowerCase());
				if (occurrences) {
					const filtered = occurrences.filter(s => s.filePath !== filePath);
					if (filtered.length === 0) {
						this._symbolIndex.delete(sym.name.toLowerCase());
					} else {
						this._symbolIndex.set(sym.name.toLowerCase(), filtered);
					}
				}
			}
			this._index.delete(filePath);
		}
	}

	searchSymbols(query: string, maxResults: number = 20): readonly IndexSearchResult[] {
		const lowerQuery = query.toLowerCase();
		const results: IndexSearchResult[] = [];

		for (const [name, symbols] of this._symbolIndex) {
			if (name.includes(lowerQuery)) {
				for (const sym of symbols) {
					const score = name === lowerQuery ? 1.0 : name.startsWith(lowerQuery) ? 0.8 : 0.5;
					results.push({
						filePath: sym.filePath,
						lineStart: sym.lineStart,
						lineEnd: sym.lineEnd,
						content: sym.signature,
						relevanceScore: score,
						reason: 'symbol_match',
					});
				}
			}
		}

		return results
			.sort((a, b) => b.relevanceScore - a.relevanceScore)
			.slice(0, maxResults);
	}

	searchFiles(query: string, maxResults: number = 20): readonly string[] {
		const lowerQuery = query.toLowerCase();
		const scored: Array<{ path: string; score: number }> = [];

		for (const filePath of this._index.keys()) {
			const fileName = filePath.split('/').pop()?.toLowerCase() ?? '';
			const lowerPath = filePath.toLowerCase();

			if (fileName.includes(lowerQuery)) {
				scored.push({ path: filePath, score: fileName === lowerQuery ? 1.0 : 0.8 });
			} else if (lowerPath.includes(lowerQuery)) {
				scored.push({ path: filePath, score: 0.4 });
			}
		}

		return scored
			.sort((a, b) => b.score - a.score)
			.slice(0, maxResults)
			.map(s => s.path);
	}

	getFileSymbols(filePath: string): readonly ForgeSymbol[] {
		return this._index.get(filePath)?.symbols ?? [];
	}

	getFileEntry(filePath: string): FileIndexEntry | undefined {
		return this._index.get(filePath);
	}

	getStats(): IndexStats {
		return {
			totalFiles: this._index.size,
			totalSymbols: this._countTotalSymbols(),
			isIndexing: this._state === ForgeIndexState.Indexing,
			lastIndexedAt: this._index.size > 0 ? Date.now() : undefined,
		};
	}

	private async _indexFile(filePath: string, uri: URI): Promise<void> {
		const stat = await this.fileService.stat(uri);
		if (this.ignoreService.exceedsMaxFileSize(stat.size)) {
			return;
		}

		// Remove old entry first
		this.removeFile(filePath);

		// Extract symbols
		const fileSymbols = await this.symbolExtractor.extractSymbols(filePath);

		// Compute content hash (simple length-based for now; real impl would use xxhash)
		const contentHash = `${stat.size}-${stat.mtime}`;

		const entry: FileIndexEntry = {
			filePath,
			language: fileSymbols.language,
			lastModified: stat.mtime,
			contentHash,
			symbols: fileSymbols.symbols,
			lineCount: 0, // Would need file content to compute
			fileSize: stat.size,
		};

		this._index.set(filePath, entry);

		// Update symbol index
		for (const sym of fileSymbols.symbols) {
			const key = sym.name.toLowerCase();
			const existing = this._symbolIndex.get(key) ?? [];
			existing.push(sym);
			this._symbolIndex.set(key, existing);
		}
	}

	private async _collectFiles(root: URI, maxFiles: number): Promise<URI[]> {
		const files: URI[] = [];

		const collectRecursive = async (dir: URI): Promise<void> => {
			if (files.length >= maxFiles) {
				return;
			}

			try {
				const entries = await this.fileService.resolve(dir);
				if (!entries.children) {
					return;
				}

				for (const child of entries.children) {
					if (files.length >= maxFiles) {
						break;
					}

					const childPath = child.resource.fsPath;
					if (this.ignoreService.isIgnored(childPath)) {
						continue;
					}

					if (child.isDirectory) {
						await collectRecursive(child.resource);
					} else {
						files.push(child.resource);
					}
				}
			} catch {
				// Directory may be unreadable
			}
		};

		await collectRecursive(root);
		return files;
	}

	private _setupFileWatcher(): void {
		const workspace = this.workspaceService.getWorkspace();
		const projectRoot = workspace.folders[0]?.uri;
		if (!projectRoot) {
			return;
		}

		const watcher = this.fileService.watch(projectRoot, { recursive: true, excludes: ['**/node_modules/**', '**/.git/**'] });
		this._watcherDisposables.add(watcher);

		this._watcherDisposables.add(this.fileService.onDidFilesChange(e => {
			for (const uri of e.rawAdded) {
				if (uri.scheme !== 'file') {
					continue;
				}
				const filePath = uri.fsPath;
				if (!this.ignoreService.isIgnored(filePath)) {
					this.updateFile(filePath);
				}
			}
			for (const uri of e.rawUpdated) {
				if (uri.scheme !== 'file') {
					continue;
				}
				const filePath = uri.fsPath;
				if (!this.ignoreService.isIgnored(filePath)) {
					this.updateFile(filePath);
				}
			}
			for (const uri of e.rawDeleted) {
				if (uri.scheme !== 'file') {
					continue;
				}
				this.removeFile(uri.fsPath);
			}
		}));
	}

	private _setState(state: ForgeIndexState): void {
		if (this._state !== state) {
			this._state = state;
			this._onDidChangeState.fire(state);
		}
	}

	private _countTotalSymbols(): number {
		let count = 0;
		for (const entry of this._index.values()) {
			count += entry.symbols.length;
		}
		return count;
	}
}

registerSingleton(IForgeIndexManager, ForgeIndexManager, InstantiationType.Delayed);
