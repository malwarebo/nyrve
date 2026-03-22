/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { IWorkspaceContextService } from '../../vs/platform/workspace/common/workspace.js';
import { URI } from '../../vs/base/common/uri.js';
import type { Database } from '@vscode/sqlite3';

// --- Service Interface ---

export const INyrveSqliteStorage = createDecorator<INyrveSqliteStorage>('nyrveSqliteStorage');

export interface INyrveSqliteStorage {
	readonly _serviceBrand: undefined;

	/** Run a SQL statement (INSERT, UPDATE, DELETE, CREATE). */
	run(sql: string, params?: unknown[]): Promise<void>;

	/** Fetch all rows from a SELECT query. */
	all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

	/** Fetch a single row from a SELECT query. */
	get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;

	/** Ensure the database connection is open and tables are created. */
	initialize(): Promise<void>;

	/** Whether the database is ready to use. */
	readonly isReady: boolean;
}

// --- Implementation ---

export class NyrveSqliteStorage extends Disposable implements INyrveSqliteStorage {
	declare readonly _serviceBrand: undefined;

	private _db: Database | undefined;
	private _isReady = false;
	private _initPromise: Promise<void> | undefined;

	get isReady(): boolean {
		return this._isReady;
	}

	constructor(
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async initialize(): Promise<void> {
		if (this._isReady) {
			return;
		}
		if (this._initPromise) {
			return this._initPromise;
		}
		this._initPromise = this._doInitialize();
		return this._initPromise;
	}

	private async _doInitialize(): Promise<void> {
		const dbPath = this._getDbPath();
		if (!dbPath) {
			this.logService.warn('[Nyrve] No workspace root, SQLite storage unavailable');
			return;
		}

		try {
			const sqlite3 = await import('@vscode/sqlite3');
			this._db = await new Promise<Database>((resolve, reject) => {
				const db = new sqlite3.default.Database(dbPath, (err: Error | null) => {
					if (err) {
						reject(err);
					} else {
						resolve(db);
					}
				});
			});

			// Enable WAL mode for better concurrent read performance
			await this._exec('PRAGMA journal_mode = WAL;');
			await this._exec('PRAGMA busy_timeout = 3000;');

			// Create tables
			await this._exec(`
				CREATE TABLE IF NOT EXISTS memories (
					id TEXT PRIMARY KEY,
					type TEXT NOT NULL,
					content TEXT NOT NULL,
					embedding TEXT NOT NULL DEFAULT '[]',
					created_at TEXT NOT NULL,
					last_accessed_at TEXT NOT NULL,
					access_count INTEGER NOT NULL DEFAULT 0,
					source TEXT NOT NULL,
					tags TEXT NOT NULL DEFAULT '[]',
					confidence REAL NOT NULL DEFAULT 0.5,
					user_verified INTEGER NOT NULL DEFAULT 0
				);
			`);

			await this._exec(`
				CREATE TABLE IF NOT EXISTS decisions (
					id TEXT PRIMARY KEY,
					title TEXT NOT NULL,
					description TEXT NOT NULL DEFAULT '',
					rationale TEXT NOT NULL DEFAULT '',
					alternatives TEXT NOT NULL DEFAULT '[]',
					date TEXT NOT NULL,
					source TEXT NOT NULL DEFAULT 'conversation',
					conversation_id TEXT,
					commit_hash TEXT,
					files_affected TEXT NOT NULL DEFAULT '[]',
					modules_affected TEXT NOT NULL DEFAULT '[]',
					tags TEXT NOT NULL DEFAULT '[]',
					status TEXT NOT NULL DEFAULT 'active',
					superseded_by TEXT,
					embedding TEXT NOT NULL DEFAULT '[]'
				);
			`);

			// Indexes for common queries
			await this._exec('CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);');
			await this._exec('CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(confidence);');
			await this._exec('CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status);');
			await this._exec('CREATE INDEX IF NOT EXISTS idx_decisions_date ON decisions(date);');

			this._isReady = true;
			this.logService.info('[Nyrve] SQLite storage initialized');
		} catch (e) {
			this.logService.error(`[Nyrve] Failed to initialize SQLite storage: ${e}`);
		}
	}

	async run(sql: string, params: unknown[] = []): Promise<void> {
		await this.initialize();
		if (!this._db) {
			return;
		}
		return new Promise((resolve, reject) => {
			this._db!.run(sql, params, (err: Error | null) => {
				if (err) {
					this.logService.error(`[Nyrve] SQLite run error: ${err.message}`);
					reject(err);
				} else {
					resolve();
				}
			});
		});
	}

	async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
		await this.initialize();
		if (!this._db) {
			return [];
		}
		return new Promise((resolve, reject) => {
			this._db!.all(sql, params, (err: Error | null, rows: T[]) => {
				if (err) {
					this.logService.error(`[Nyrve] SQLite all error: ${err.message}`);
					reject(err);
				} else {
					resolve(rows ?? []);
				}
			});
		});
	}

	async get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
		await this.initialize();
		if (!this._db) {
			return undefined;
		}
		return new Promise((resolve, reject) => {
			this._db!.get(sql, params, (err: Error | null, row: T) => {
				if (err) {
					this.logService.error(`[Nyrve] SQLite get error: ${err.message}`);
					reject(err);
				} else {
					resolve(row);
				}
			});
		});
	}

	private _exec(sql: string): Promise<void> {
		return new Promise((resolve, reject) => {
			this._db!.exec(sql, (err: Error | null) => {
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			});
		});
	}

	private _getDbPath(): string | undefined {
		const folders = this.workspaceService.getWorkspace().folders;
		if (folders.length === 0) {
			return undefined;
		}
		const root = folders[0].uri;
		return URI.joinPath(root, '.nyrve', 'memory.db').fsPath;
	}

	override dispose(): void {
		if (this._db) {
			this._db.close();
			this._db = undefined;
		}
		super.dispose();
	}
}

registerSingleton(INyrveSqliteStorage, NyrveSqliteStorage, InstantiationType.Delayed);
