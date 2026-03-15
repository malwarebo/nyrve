/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../vs/base/common/uri.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { IFileService } from '../../vs/platform/files/common/files.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { IWorkspaceContextService } from '../../vs/platform/workspace/common/workspace.js';

// --- Types ---

export interface SharedMemoryData {
	readonly project?: {
		readonly name?: string;
		readonly description?: string;
		readonly techStack?: readonly string[];
		readonly conventions?: readonly string[];
	};
	readonly architecture?: ReadonlyArray<{
		readonly decision: string;
		readonly date?: string;
		readonly reason?: string;
	}>;
	readonly knownIssues?: readonly string[];
}

// --- Service Interface ---

export const IForgeSharedMemory = createDecorator<IForgeSharedMemory>('forgeSharedMemory');

export interface IForgeSharedMemory {
	readonly _serviceBrand: undefined;

	/** Load shared memory from .forge/shared-memory.json. */
	load(): Promise<void>;

	/** Get the loaded shared memory data. */
	getData(): SharedMemoryData | undefined;

	/** Build a context string from shared memory for the agent system prompt. */
	buildSharedContext(): string;
}

// --- Service Implementation ---

export class ForgeSharedMemory extends Disposable implements IForgeSharedMemory {
	declare readonly _serviceBrand: undefined;

	private _data: SharedMemoryData | undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async load(): Promise<void> {
		const workspace = this.workspaceService.getWorkspace();
		const projectRoot = workspace.folders[0]?.uri;
		if (!projectRoot) {
			return;
		}

		const uri = URI.joinPath(projectRoot, '.forge', 'shared-memory.json');
		try {
			const exists = await this.fileService.exists(uri);
			if (!exists) {
				this._data = undefined;
				return;
			}

			const content = await this.fileService.readFile(uri);
			this._data = JSON.parse(content.value.toString());
			this.logService.info('[Forge] Loaded shared memory');
		} catch (e) {
			this.logService.warn(`[Forge] Failed to load shared memory: ${e}`);
			this._data = undefined;
		}
	}

	getData(): SharedMemoryData | undefined {
		return this._data;
	}

	buildSharedContext(): string {
		if (!this._data) {
			return '';
		}

		const parts: string[] = ['## Team Shared Memory'];

		if (this._data.project) {
			const p = this._data.project;
			if (p.name || p.description) {
				parts.push(`\n### Project: ${p.name ?? 'Unknown'}`);
				if (p.description) {
					parts.push(p.description);
				}
			}
			if (p.techStack && p.techStack.length > 0) {
				parts.push(`\n**Tech stack:** ${p.techStack.join(', ')}`);
			}
			if (p.conventions && p.conventions.length > 0) {
				parts.push('\n**Conventions:**');
				for (const conv of p.conventions) {
					parts.push(`- ${conv}`);
				}
			}
		}

		if (this._data.architecture && this._data.architecture.length > 0) {
			parts.push('\n### Architecture Decisions');
			for (const dec of this._data.architecture) {
				let line = `- ${dec.decision}`;
				if (dec.reason) {
					line += ` (reason: ${dec.reason})`;
				}
				parts.push(line);
			}
		}

		if (this._data.knownIssues && this._data.knownIssues.length > 0) {
			parts.push('\n### Known Issues');
			for (const issue of this._data.knownIssues) {
				parts.push(`- ${issue}`);
			}
		}

		return parts.length > 1 ? parts.join('\n') : '';
	}
}

registerSingleton(IForgeSharedMemory, ForgeSharedMemory, InstantiationType.Delayed);
