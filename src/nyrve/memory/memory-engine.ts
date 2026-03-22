/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../vs/base/common/uri.js';
import { Event, Emitter } from '../../vs/base/common/event.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { IFileService } from '../../vs/platform/files/common/files.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { IWorkspaceContextService } from '../../vs/platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import { VSBuffer } from '../../vs/base/common/buffer.js';
import { INyrveSqliteStorage } from './sqlite-storage.js';

// --- Text Utilities ---

const STOP_WORDS = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'and', 'but', 'or', 'not', 'no', 'if', 'then', 'than', 'that', 'this', 'it', 'its', 'we', 'they', 'i', 'you', 'he', 'she']);

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9_\-]/g, ' ')
		.split(/\s+/)
		.filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

// --- Types ---

export enum MemoryType {
	ArchitectureDecision = 'ARCHITECTURE_DECISION',
	Convention = 'CONVENTION',
	TechStack = 'TECH_STACK',
	ProjectStructure = 'PROJECT_STRUCTURE',
	CodingStyle = 'CODING_STYLE',
	ToolPreference = 'TOOL_PREFERENCE',
	ReviewPreference = 'REVIEW_PREFERENCE',
	TaskHistory = 'TASK_HISTORY',
	UnresolvedTodo = 'UNRESOLVED_TODO',
	BugContext = 'BUG_CONTEXT',
	ErrorResolution = 'ERROR_RESOLUTION',
	CodebasePattern = 'CODEBASE_PATTERN',
	DependencyNote = 'DEPENDENCY_NOTE',
}

export enum MemorySource {
	Conversation = 'CONVERSATION',
	CodeAnalysis = 'CODE_ANALYSIS',
	UserExplicit = 'USER_EXPLICIT',
	GitHistory = 'GIT_HISTORY',
	Documentation = 'DOCUMENTATION',
}

export interface MemoryEntry {
	id: string;
	type: MemoryType;
	content: string;
	embedding: number[];
	createdAt: string;
	lastAccessedAt: string;
	accessCount: number;
	source: MemorySource;
	tags: string[];
	confidence: number;
	userVerified: boolean;
}

export interface MemoryStats {
	readonly totalEntries: number;
	readonly verifiedEntries: number;
	readonly avgConfidence: number;
}

// --- Service Interface ---

export const INyrveMemoryEngine = createDecorator<INyrveMemoryEngine>('nyrveMemoryEngine');

export interface INyrveMemoryEngine {
	readonly _serviceBrand: undefined;

	readonly onDidAddMemory: Event<MemoryEntry>;
	readonly onDidUpdateMemory: Event<MemoryEntry>;
	readonly onDidDeleteMemory: Event<string>;

	/** Load memories from storage. */
	load(): Promise<void>;

	/** Save memories to storage. */
	save(): Promise<void>;

	/** Create a new memory entry. */
	addMemory(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'lastAccessedAt' | 'accessCount'>): MemoryEntry;

	/** Update an existing memory. */
	updateMemory(id: string, update: Partial<Pick<MemoryEntry, 'content' | 'confidence' | 'userVerified' | 'tags'>>): void;

	/** Delete a memory. */
	deleteMemory(id: string): void;

	/** Get a memory by ID. */
	getMemory(id: string): MemoryEntry | undefined;

	/** Get all memories. */
	getAllMemories(): readonly MemoryEntry[];

	/** Search memories by text content. */
	searchByContent(query: string, maxResults?: number): readonly MemoryEntry[];

	/** Search memories by type. */
	searchByType(type: MemoryType): readonly MemoryEntry[];

	/** Get the most accessed memories (always-on context). */
	getTopMemories(count?: number): readonly MemoryEntry[];

	/** Build the memory context string for the agent system prompt. */
	buildMemoryContext(tokenBudget?: number): string;

	/** Get memory statistics. */
	getStats(): MemoryStats;
}

// --- Service Implementation ---

export class NyrveMemoryEngine extends Disposable implements INyrveMemoryEngine {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidAddMemory = this._register(new Emitter<MemoryEntry>());
	readonly onDidAddMemory: Event<MemoryEntry> = this._onDidAddMemory.event;

	private readonly _onDidUpdateMemory = this._register(new Emitter<MemoryEntry>());
	readonly onDidUpdateMemory: Event<MemoryEntry> = this._onDidUpdateMemory.event;

	private readonly _onDidDeleteMemory = this._register(new Emitter<string>());
	readonly onDidDeleteMemory: Event<string> = this._onDidDeleteMemory.event;

	private readonly _memories = new Map<string, MemoryEntry>();

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@INyrveSqliteStorage private readonly sqliteStorage: INyrveSqliteStorage,
	) {
		super();
	}

	async load(): Promise<void> {
		// Try SQLite first
		if (await this._loadFromSqlite()) {
			// Migrate: clean up old JSON file if it exists
			this._deleteJsonFile();
			return;
		}

		// Fall back to JSON (legacy migration path)
		await this._loadFromJson();

		// If we loaded from JSON and SQLite is available, migrate data
		if (this._memories.size > 0 && this.sqliteStorage.isReady) {
			await this._migrateToSqlite();
		}
	}

	private async _loadFromSqlite(): Promise<boolean> {
		try {
			await this.sqliteStorage.initialize();
			if (!this.sqliteStorage.isReady) {
				return false;
			}

			const rows = await this.sqliteStorage.all<MemoryRow>(
				'SELECT * FROM memories'
			);

			if (rows.length === 0) {
				return false;
			}

			this._memories.clear();
			for (const row of rows) {
				const entry = this._rowToEntry(row);
				this._memories.set(entry.id, entry);
			}
			this.logService.info(`[Nyrve] Loaded ${this._memories.size} memories from SQLite`);
			return true;
		} catch {
			return false;
		}
	}

	private async _loadFromJson(): Promise<void> {
		const uri = this._getStorageUri();
		if (!uri) {
			return;
		}

		try {
			const exists = await this.fileService.exists(uri);
			if (!exists) {
				return;
			}

			const content = await this.fileService.readFile(uri);
			const entries: MemoryEntry[] = JSON.parse(content.value.toString());
			this._memories.clear();
			for (const entry of entries) {
				this._memories.set(entry.id, entry);
			}
			this.logService.info(`[Nyrve] Loaded ${this._memories.size} memories from JSON (legacy)`);
		} catch (e) {
			this.logService.warn(`[Nyrve] Failed to load memories: ${e}`);
		}
	}

	private async _migrateToSqlite(): Promise<void> {
		try {
			for (const entry of this._memories.values()) {
				await this.sqliteStorage.run(
					`INSERT OR REPLACE INTO memories (id, type, content, embedding, created_at, last_accessed_at, access_count, source, tags, confidence, user_verified)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						entry.id, entry.type, entry.content, JSON.stringify(entry.embedding),
						entry.createdAt, entry.lastAccessedAt, entry.accessCount, entry.source,
						JSON.stringify(entry.tags), entry.confidence, entry.userVerified ? 1 : 0,
					],
				);
			}
			this.logService.info(`[Nyrve] Migrated ${this._memories.size} memories to SQLite`);
			this._deleteJsonFile();
		} catch (e) {
			this.logService.warn(`[Nyrve] Failed to migrate memories to SQLite: ${e}`);
		}
	}

	private async _deleteJsonFile(): Promise<void> {
		const uri = this._getStorageUri();
		if (!uri) {
			return;
		}
		try {
			const exists = await this.fileService.exists(uri);
			if (exists) {
				await this.fileService.del(uri);
				this.logService.info('[Nyrve] Removed legacy memory.json after SQLite migration');
			}
		} catch {
			// Ignore cleanup failures
		}
	}

	async save(): Promise<void> {
		// Save to SQLite if available
		if (this.sqliteStorage.isReady) {
			await this._saveToSqlite();
			return;
		}

		// Fallback to JSON
		await this._saveToJson();
	}

	private async _saveToSqlite(): Promise<void> {
		try {
			for (const entry of this._memories.values()) {
				await this.sqliteStorage.run(
					`INSERT OR REPLACE INTO memories (id, type, content, embedding, created_at, last_accessed_at, access_count, source, tags, confidence, user_verified)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						entry.id, entry.type, entry.content, JSON.stringify(entry.embedding),
						entry.createdAt, entry.lastAccessedAt, entry.accessCount, entry.source,
						JSON.stringify(entry.tags), entry.confidence, entry.userVerified ? 1 : 0,
					],
				);
			}
			this.logService.trace(`[Nyrve] Saved ${this._memories.size} memories to SQLite`);
		} catch (e) {
			this.logService.warn(`[Nyrve] Failed to save memories to SQLite: ${e}`);
			await this._saveToJson();
		}
	}

	private async _saveToJson(): Promise<void> {
		const uri = this._getStorageUri();
		if (!uri) {
			return;
		}

		try {
			const entries = [...this._memories.values()];
			const content = JSON.stringify(entries, null, 2);
			await this.fileService.writeFile(uri, VSBuffer.fromString(content));
			this.logService.trace(`[Nyrve] Saved ${entries.length} memories`);
		} catch (e) {
			this.logService.warn(`[Nyrve] Failed to save memories: ${e}`);
		}
	}

	addMemory(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'lastAccessedAt' | 'accessCount'>): MemoryEntry {
		const maxEntries = this.configurationService.getValue<number>('nyrve.memory.maxEntries') ?? 1000;
		if (this._memories.size >= maxEntries) {
			this._evictLowestConfidence();
		}

		const now = new Date().toISOString();
		const memory: MemoryEntry = {
			...entry,
			id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
			createdAt: now,
			lastAccessedAt: now,
			accessCount: 0,
		};

		this._memories.set(memory.id, memory);
		this._onDidAddMemory.fire(memory);
		this.logService.trace(`[Nyrve] Added memory: ${memory.type} — ${memory.content.slice(0, 60)}...`);

		return memory;
	}

	updateMemory(id: string, update: Partial<Pick<MemoryEntry, 'content' | 'confidence' | 'userVerified' | 'tags'>>): void {
		const memory = this._memories.get(id);
		if (!memory) {
			return;
		}

		if (update.content !== undefined) { memory.content = update.content; }
		if (update.confidence !== undefined) { memory.confidence = update.confidence; }
		if (update.userVerified !== undefined) { memory.userVerified = update.userVerified; }
		if (update.tags !== undefined) { memory.tags = update.tags; }

		this._onDidUpdateMemory.fire(memory);
	}

	deleteMemory(id: string): void {
		if (this._memories.delete(id)) {
			this._onDidDeleteMemory.fire(id);
		}
	}

	getMemory(id: string): MemoryEntry | undefined {
		const memory = this._memories.get(id);
		if (memory) {
			memory.lastAccessedAt = new Date().toISOString();
			memory.accessCount++;
		}
		return memory;
	}

	getAllMemories(): readonly MemoryEntry[] {
		return [...this._memories.values()];
	}

	searchByContent(query: string, maxResults: number = 10): readonly MemoryEntry[] {
		const queryTerms = tokenize(query);
		if (queryTerms.length === 0) {
			return [];
		}

		const allMemories = this.getAllMemories();
		const corpus = allMemories.map(m => tokenize(m.content + ' ' + m.tags.join(' ')));
		const avgDocLen = corpus.reduce((sum, doc) => sum + doc.length, 0) / (corpus.length || 1);

		// Compute IDF for each query term
		const idf = new Map<string, number>();
		for (const term of queryTerms) {
			const docsContaining = corpus.filter(doc => doc.includes(term)).length;
			idf.set(term, Math.log((corpus.length - docsContaining + 0.5) / (docsContaining + 0.5) + 1));
		}

		const k1 = 1.5;
		const b = 0.75;

		const scored = allMemories.map((memory, idx) => {
			const doc = corpus[idx];
			let score = 0;
			for (const term of queryTerms) {
				const tf = doc.filter(t => t === term).length;
				const termIdf = idf.get(term) ?? 0;
				score += termIdf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.length / avgDocLen))));
			}
			// Blend BM25 score with confidence
			score *= (0.5 + 0.5 * memory.confidence);
			return { memory, score };
		});

		return scored
			.filter(s => s.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, maxResults)
			.map(s => s.memory);
	}

	searchByType(type: MemoryType): readonly MemoryEntry[] {
		return this.getAllMemories().filter(m => m.type === type);
	}

	getTopMemories(count: number = 5): readonly MemoryEntry[] {
		return this.getAllMemories()
			.filter(m => m.confidence >= 0.5)
			.sort((a, b) => b.accessCount - a.accessCount)
			.slice(0, count);
	}

	buildMemoryContext(tokenBudget: number = 2000): string {
		const sections = new Map<string, string[]>();

		// Group memories by category for the system prompt
		const groupMap: Record<string, string> = {
			[MemoryType.ArchitectureDecision]: 'Architecture',
			[MemoryType.Convention]: 'Conventions',
			[MemoryType.TechStack]: 'Tech Stack',
			[MemoryType.ProjectStructure]: 'Project Structure',
			[MemoryType.CodingStyle]: 'User Preferences',
			[MemoryType.ToolPreference]: 'User Preferences',
			[MemoryType.ReviewPreference]: 'User Preferences',
			[MemoryType.TaskHistory]: 'Recent Context',
			[MemoryType.UnresolvedTodo]: 'Recent Context',
			[MemoryType.BugContext]: 'Known Issues',
			[MemoryType.ErrorResolution]: 'Known Issues',
			[MemoryType.CodebasePattern]: 'Codebase Patterns',
			[MemoryType.DependencyNote]: 'Dependencies',
		};

		// Get top memories and high-confidence ones
		const relevantMemories = this.getAllMemories()
			.filter(m => m.confidence >= 0.5)
			.sort((a, b) => b.confidence - a.confidence || b.accessCount - a.accessCount);

		let tokenEstimate = 0;
		for (const memory of relevantMemories) {
			const entryTokens = Math.ceil(memory.content.length / 4);
			if (tokenEstimate + entryTokens > tokenBudget) {
				break;
			}

			const group = groupMap[memory.type] ?? 'Other';
			if (!sections.has(group)) {
				sections.set(group, []);
			}
			sections.get(group)!.push(`- ${memory.content}`);
			tokenEstimate += entryTokens;
		}

		if (sections.size === 0) {
			return '';
		}

		const parts = ['## Project Memory'];
		for (const [title, items] of sections) {
			parts.push(`\n### ${title}`);
			parts.push(...items);
		}

		return parts.join('\n');
	}

	getStats(): MemoryStats {
		const all = this.getAllMemories();
		const avgConfidence = all.length > 0
			? all.reduce((sum, m) => sum + m.confidence, 0) / all.length
			: 0;

		return {
			totalEntries: all.length,
			verifiedEntries: all.filter(m => m.userVerified).length,
			avgConfidence,
		};
	}

	private _evictLowestConfidence(): void {
		let lowest: MemoryEntry | undefined;
		for (const memory of this._memories.values()) {
			if (!memory.userVerified && (!lowest || memory.confidence < lowest.confidence)) {
				lowest = memory;
			}
		}
		if (lowest) {
			this.deleteMemory(lowest.id);
		}
	}

	private _rowToEntry(row: MemoryRow): MemoryEntry {
		return {
			id: row.id,
			type: row.type as MemoryType,
			content: row.content,
			embedding: JSON.parse(row.embedding),
			createdAt: row.created_at,
			lastAccessedAt: row.last_accessed_at,
			accessCount: row.access_count,
			source: row.source as MemorySource,
			tags: JSON.parse(row.tags),
			confidence: row.confidence,
			userVerified: row.user_verified === 1,
		};
	}

	private _getStorageUri(): URI | undefined {
		const workspace = this.workspaceService.getWorkspace();
		const projectRoot = workspace.folders[0]?.uri;
		if (!projectRoot) {
			return undefined;
		}
		return URI.joinPath(projectRoot, '.nyrve', 'memory.json');
	}
}

interface MemoryRow {
	id: string;
	type: string;
	content: string;
	embedding: string;
	created_at: string;
	last_accessed_at: string;
	access_count: number;
	source: string;
	tags: string;
	confidence: number;
	user_verified: number;
}

registerSingleton(INyrveMemoryEngine, NyrveMemoryEngine, InstantiationType.Delayed);
