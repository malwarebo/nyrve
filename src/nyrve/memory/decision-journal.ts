/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../vs/base/common/event.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { IFileService } from '../../vs/platform/files/common/files.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../vs/platform/workspace/common/workspace.js';
import { URI } from '../../vs/base/common/uri.js';
import { VSBuffer } from '../../vs/base/common/buffer.js';
import { INyrveSqliteStorage } from './sqlite-storage.js';

// --- Text Utilities ---

const BM25_STOP_WORDS = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'and', 'but', 'or', 'not', 'no', 'if', 'then', 'than', 'that', 'this', 'it', 'its', 'we', 'they', 'i', 'you', 'he', 'she']);

function bm25Tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9_\-]/g, ' ')
		.split(/\s+/)
		.filter(t => t.length > 1 && !BM25_STOP_WORDS.has(t));
}

// --- Types ---

export interface DecisionEntry {
	id: string;
	title: string;
	description: string;
	rationale: string;
	alternativesConsidered: Array<{ name: string; reason: string }>;
	date: string;
	source: 'conversation' | 'commit' | 'user_explicit';
	conversationId?: string;
	commitHash?: string;
	filesAffected: string[];
	modulesAffected: string[];
	tags: string[];
	status: 'active' | 'superseded' | 'deprecated';
	supersededBy?: string;
	embedding: number[];
}

// --- Service Interface ---

export const INyrveDecisionJournal = createDecorator<INyrveDecisionJournal>('nyrveDecisionJournal');

export interface INyrveDecisionJournal {
	readonly _serviceBrand: undefined;

	/** Fires when a new decision is added. */
	readonly onDidAddDecision: Event<DecisionEntry>;

	// CRUD
	addDecision(entry: Partial<DecisionEntry>): Promise<string>;
	getDecision(id: string): Promise<DecisionEntry | undefined>;
	updateDecision(id: string, updates: Partial<DecisionEntry>): Promise<void>;
	deleteDecision(id: string): Promise<void>;

	// Search
	searchDecisions(query: string, topK?: number): Promise<DecisionEntry[]>;
	getDecisionsByModule(module: string): Promise<DecisionEntry[]>;
	getDecisionsByTag(tag: string): Promise<DecisionEntry[]>;
	getRecentDecisions(days: number): Promise<DecisionEntry[]>;
	getAllDecisions(): Promise<DecisionEntry[]>;

	// Persistence
	getEntryCount(): number;
}

// --- Service Implementation ---

export class NyrveDecisionJournal extends Disposable implements INyrveDecisionJournal {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidAddDecision = this._register(new Emitter<DecisionEntry>());
	readonly onDidAddDecision: Event<DecisionEntry> = this._onDidAddDecision.event;

	/** In-memory store. Persisted to .nyrve/decisions.json. */
	private _entries: DecisionEntry[] = [];
	private _loaded = false;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
		@INyrveSqliteStorage private readonly sqliteStorage: INyrveSqliteStorage,
	) {
		super();
		this._loadFromDisk();
	}

	getEntryCount(): number {
		return this._entries.length;
	}

	async addDecision(partial: Partial<DecisionEntry>): Promise<string> {
		await this._ensureLoaded();

		const maxEntries = this.configurationService.getValue<number>('nyrve.memory.decisions.maxEntries') ?? 500;

		const entry: DecisionEntry = {
			id: this._generateId(),
			title: partial.title ?? '',
			description: partial.description ?? '',
			rationale: partial.rationale ?? '',
			alternativesConsidered: partial.alternativesConsidered ?? [],
			date: partial.date ?? new Date().toISOString(),
			source: partial.source ?? 'conversation',
			conversationId: partial.conversationId,
			commitHash: partial.commitHash,
			filesAffected: partial.filesAffected ?? [],
			modulesAffected: partial.modulesAffected ?? [],
			tags: partial.tags ?? [],
			status: partial.status ?? 'active',
			supersededBy: partial.supersededBy,
			embedding: partial.embedding ?? [],
		};

		this._entries.push(entry);

		// Evict oldest entries if over max
		if (this._entries.length > maxEntries) {
			this._entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
			this._entries = this._entries.slice(0, maxEntries);
		}

		await this._saveToDisk();
		this._onDidAddDecision.fire(entry);
		this.logService.info(`[Nyrve] Decision added: "${entry.title}" (${entry.source})`);

		return entry.id;
	}

	async getDecision(id: string): Promise<DecisionEntry | undefined> {
		await this._ensureLoaded();
		return this._entries.find(e => e.id === id);
	}

	async updateDecision(id: string, updates: Partial<DecisionEntry>): Promise<void> {
		await this._ensureLoaded();
		const idx = this._entries.findIndex(e => e.id === id);
		if (idx >= 0) {
			this._entries[idx] = { ...this._entries[idx], ...updates, id };
			await this._saveToDisk();
		}
	}

	async deleteDecision(id: string): Promise<void> {
		await this._ensureLoaded();
		this._entries = this._entries.filter(e => e.id !== id);
		await this._saveToDisk();
	}

	async searchDecisions(query: string, topK: number = 5): Promise<DecisionEntry[]> {
		await this._ensureLoaded();

		const queryTerms = bm25Tokenize(query);
		if (queryTerms.length === 0) {
			return [];
		}

		const activeEntries = this._entries.filter(e => e.status === 'active');

		// Build searchable documents with field weights
		const docs = activeEntries.map(entry => {
			const titleTokens = bm25Tokenize(entry.title);
			const descTokens = bm25Tokenize(entry.description);
			const rationaleTokens = bm25Tokenize(entry.rationale);
			const tagTokens = bm25Tokenize(entry.tags.join(' '));
			// Weight title and tags higher by repeating tokens
			return [...titleTokens, ...titleTokens, ...titleTokens, ...tagTokens, ...tagTokens, ...descTokens, ...rationaleTokens];
		});

		const avgDocLen = docs.reduce((sum, doc) => sum + doc.length, 0) / (docs.length || 1);
		const k1 = 1.5;
		const b = 0.75;

		// Compute IDF
		const idf = new Map<string, number>();
		for (const term of queryTerms) {
			const docsContaining = docs.filter(doc => doc.includes(term)).length;
			idf.set(term, Math.log((docs.length - docsContaining + 0.5) / (docsContaining + 0.5) + 1));
		}

		const scored = activeEntries.map((entry, idx) => {
			const doc = docs[idx];
			let score = 0;
			for (const term of queryTerms) {
				const tf = doc.filter(t => t === term).length;
				const termIdf = idf.get(term) ?? 0;
				score += termIdf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.length / avgDocLen))));
			}
			return { entry, score };
		});

		return scored
			.filter(s => s.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, topK)
			.map(s => s.entry);
	}

	async getDecisionsByModule(module: string): Promise<DecisionEntry[]> {
		await this._ensureLoaded();
		return this._entries.filter(e =>
			e.status === 'active' &&
			e.modulesAffected.some(m => m.toLowerCase().includes(module.toLowerCase()))
		);
	}

	async getDecisionsByTag(tag: string): Promise<DecisionEntry[]> {
		await this._ensureLoaded();
		return this._entries.filter(e =>
			e.status === 'active' &&
			e.tags.some(t => t.toLowerCase() === tag.toLowerCase())
		);
	}

	async getRecentDecisions(days: number): Promise<DecisionEntry[]> {
		await this._ensureLoaded();
		const cutoff = Date.now() - (days * 86400 * 1000);
		return this._entries
			.filter(e => new Date(e.date).getTime() > cutoff)
			.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
	}

	async getAllDecisions(): Promise<DecisionEntry[]> {
		await this._ensureLoaded();
		return [...this._entries].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
	}

	// --- Persistence ---

	private async _ensureLoaded(): Promise<void> {
		if (!this._loaded) {
			await this._loadFromDisk();
		}
	}

	private async _loadFromDisk(): Promise<void> {
		const root = this._getWorkspaceRoot();
		if (!root) {
			this._loaded = true;
			return;
		}

		// Try SQLite first
		if (await this._loadFromSqlite()) {
			this._deleteJsonFile(root);
			this._loaded = true;
			return;
		}

		// Fall back to JSON (legacy)
		try {
			const uri = URI.joinPath(root, '.nyrve', 'decisions.json');
			const content = await this.fileService.readFile(uri);
			this._entries = JSON.parse(content.value.toString());
			this.logService.info(`[Nyrve] Loaded ${this._entries.length} decisions from JSON (legacy)`);

			// Migrate to SQLite if available
			if (this._entries.length > 0) {
				await this._migrateToSqlite();
			}
		} catch {
			this._entries = [];
		}
		this._loaded = true;
	}

	private async _loadFromSqlite(): Promise<boolean> {
		try {
			await this.sqliteStorage.initialize();
			if (!this.sqliteStorage.isReady) {
				return false;
			}

			const rows = await this.sqliteStorage.all<DecisionRow>(
				'SELECT * FROM decisions'
			);

			if (rows.length === 0) {
				return false;
			}

			this._entries = rows.map(r => this._rowToEntry(r));
			this.logService.info(`[Nyrve] Loaded ${this._entries.length} decisions from SQLite`);
			return true;
		} catch {
			return false;
		}
	}

	private async _migrateToSqlite(): Promise<void> {
		try {
			await this.sqliteStorage.initialize();
			if (!this.sqliteStorage.isReady) {
				return;
			}

			for (const entry of this._entries) {
				await this._insertToSqlite(entry);
			}
			this.logService.info(`[Nyrve] Migrated ${this._entries.length} decisions to SQLite`);
		} catch (e) {
			this.logService.warn(`[Nyrve] Failed to migrate decisions to SQLite: ${e}`);
		}
	}

	private async _deleteJsonFile(root: URI): Promise<void> {
		try {
			const uri = URI.joinPath(root, '.nyrve', 'decisions.json');
			const exists = await this.fileService.exists(uri);
			if (exists) {
				await this.fileService.del(uri);
			}
		} catch {
			// Ignore
		}
	}

	private async _saveToDisk(): Promise<void> {
		// Save to SQLite if available
		if (this.sqliteStorage.isReady) {
			await this._saveToSqlite();
			return;
		}

		// Fallback to JSON
		const root = this._getWorkspaceRoot();
		if (!root) {
			return;
		}

		try {
			const uri = URI.joinPath(root, '.nyrve', 'decisions.json');
			const content = JSON.stringify(this._entries, null, 2);
			await this.fileService.writeFile(uri, VSBuffer.fromString(content));
		} catch (error) {
			this.logService.error(`[Nyrve] Failed to save decisions: ${error}`);
		}
	}

	private async _saveToSqlite(): Promise<void> {
		try {
			// Clear and re-insert all entries (simple approach; could be optimized)
			await this.sqliteStorage.run('DELETE FROM decisions');
			for (const entry of this._entries) {
				await this._insertToSqlite(entry);
			}
		} catch (e) {
			this.logService.error(`[Nyrve] Failed to save decisions to SQLite: ${e}`);
		}
	}

	private async _insertToSqlite(entry: DecisionEntry): Promise<void> {
		await this.sqliteStorage.run(
			`INSERT OR REPLACE INTO decisions (id, title, description, rationale, alternatives, date, source, conversation_id, commit_hash, files_affected, modules_affected, tags, status, superseded_by, embedding)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				entry.id, entry.title, entry.description, entry.rationale,
				JSON.stringify(entry.alternativesConsidered), entry.date, entry.source,
				entry.conversationId ?? null, entry.commitHash ?? null,
				JSON.stringify(entry.filesAffected), JSON.stringify(entry.modulesAffected),
				JSON.stringify(entry.tags), entry.status, entry.supersededBy ?? null,
				JSON.stringify(entry.embedding),
			],
		);
	}

	private _getWorkspaceRoot(): URI | undefined {
		const folders = this.workspaceContextService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri : undefined;
	}

	private _rowToEntry(row: DecisionRow): DecisionEntry {
		return {
			id: row.id,
			title: row.title,
			description: row.description,
			rationale: row.rationale,
			alternativesConsidered: JSON.parse(row.alternatives),
			date: row.date,
			source: row.source as DecisionEntry['source'],
			conversationId: row.conversation_id ?? undefined,
			commitHash: row.commit_hash ?? undefined,
			filesAffected: JSON.parse(row.files_affected),
			modulesAffected: JSON.parse(row.modules_affected),
			tags: JSON.parse(row.tags),
			status: row.status as DecisionEntry['status'],
			supersededBy: row.superseded_by ?? undefined,
			embedding: JSON.parse(row.embedding),
		};
	}

	private _generateId(): string {
		return `dec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	}
}

interface DecisionRow {
	id: string;
	title: string;
	description: string;
	rationale: string;
	alternatives: string;
	date: string;
	source: string;
	conversation_id: string | null;
	commit_hash: string | null;
	files_affected: string;
	modules_affected: string;
	tags: string;
	status: string;
	superseded_by: string | null;
	embedding: string;
}

registerSingleton(INyrveDecisionJournal, NyrveDecisionJournal, InstantiationType.Delayed);
