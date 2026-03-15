/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { IFileService } from '../../vs/platform/files/common/files.js';
import { URI } from '../../vs/base/common/uri.js';
import { VSBuffer } from '../../vs/base/common/buffer.js';

// --- Constants ---

export const FORGE_DATA_DIR = '.forge';
export const FORGE_INDEX_DB = 'index.db';
export const FORGE_MEMORY_DB = 'memory.json';
export const FORGE_TASKS_DB = 'tasks.json';
export const FORGE_CONFIG_FILE = 'config.json';

// --- Service Interface ---

export const IForgeStorage = createDecorator<IForgeStorage>('forgeStorage');

export interface IForgeStorage {
	readonly _serviceBrand: undefined;

	/** Get the .forge directory URI for the workspace. */
	getDataDir(): URI | undefined;

	/** Set the workspace root. */
	setWorkspaceRoot(root: URI): void;

	/** Read a JSON file from the .forge directory. */
	readJSON<T>(filename: string): Promise<T | undefined>;

	/** Write a JSON file to the .forge directory. */
	writeJSON(filename: string, data: unknown): Promise<void>;

	/** Check if a file exists in the .forge directory. */
	exists(filename: string): Promise<boolean>;

	/** Delete a file from the .forge directory. */
	deleteFile(filename: string): Promise<void>;

	/** Ensure the .forge directory exists. */
	ensureDataDir(): Promise<void>;
}

// --- Service Implementation ---

export class ForgeStorage extends Disposable implements IForgeStorage {
	declare readonly _serviceBrand: undefined;

	private _workspaceRoot: URI | undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	getDataDir(): URI | undefined {
		if (!this._workspaceRoot) {
			return undefined;
		}
		return URI.joinPath(this._workspaceRoot, FORGE_DATA_DIR);
	}

	setWorkspaceRoot(root: URI): void {
		this._workspaceRoot = root;
	}

	async readJSON<T>(filename: string): Promise<T | undefined> {
		const dataDir = this.getDataDir();
		if (!dataDir) {
			return undefined;
		}

		const fileUri = URI.joinPath(dataDir, filename);
		try {
			const content = await this.fileService.readFile(fileUri);
			return JSON.parse(content.value.toString()) as T;
		} catch {
			return undefined;
		}
	}

	async writeJSON(filename: string, data: unknown): Promise<void> {
		const dataDir = this.getDataDir();
		if (!dataDir) {
			this.logService.warn('[Forge] Cannot write JSON — no workspace root set');
			return;
		}

		await this.ensureDataDir();

		const fileUri = URI.joinPath(dataDir, filename);
		const content = JSON.stringify(data, null, '\t');
		await this.fileService.writeFile(fileUri, VSBuffer.fromString(content));
	}

	async exists(filename: string): Promise<boolean> {
		const dataDir = this.getDataDir();
		if (!dataDir) {
			return false;
		}

		const fileUri = URI.joinPath(dataDir, filename);
		try {
			return await this.fileService.exists(fileUri);
		} catch {
			return false;
		}
	}

	async deleteFile(filename: string): Promise<void> {
		const dataDir = this.getDataDir();
		if (!dataDir) {
			return;
		}

		const fileUri = URI.joinPath(dataDir, filename);
		try {
			await this.fileService.del(fileUri);
		} catch {
			// File may not exist
		}
	}

	async ensureDataDir(): Promise<void> {
		const dataDir = this.getDataDir();
		if (!dataDir) {
			return;
		}

		try {
			const stat = await this.fileService.resolve(dataDir);
			if (!stat.isDirectory) {
				this.logService.warn('[Forge] .forge exists but is not a directory');
			}
		} catch {
			await this.fileService.createFolder(dataDir);
			this.logService.info('[Forge] Created .forge data directory');
		}
	}
}

registerSingleton(IForgeStorage, ForgeStorage, InstantiationType.Delayed);
