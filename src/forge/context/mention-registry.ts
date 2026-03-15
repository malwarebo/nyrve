/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../vs/base/common/uri.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { IFileService } from '../../vs/platform/files/common/files.js';
import { IWorkspaceContextService } from '../../vs/platform/workspace/common/workspace.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { MentionType } from './context-builder.js';

// --- Types ---

export interface MentionDefinition {
	readonly type: MentionType;
	readonly name: string;
	readonly description: string;
	readonly syntax: string;
	readonly hasArgument: boolean;
	readonly argumentHint?: string;
	readonly isBuiltIn: boolean;
}

export interface CustomMentionDefinition {
	readonly name: string;
	readonly description: string;
	readonly glob?: string;
	readonly files?: string[];
}

// --- Service Interface ---

export const IForgeMentionRegistry = createDecorator<IForgeMentionRegistry>('forgeMentionRegistry');

export interface IForgeMentionRegistry {
	readonly _serviceBrand: undefined;

	/** Get all available mention definitions (built-in + custom). */
	getAllMentions(): readonly MentionDefinition[];

	/** Get built-in mentions only. */
	getBuiltInMentions(): readonly MentionDefinition[];

	/** Get custom mentions from .forge/mentions.json. */
	getCustomMentions(): readonly MentionDefinition[];

	/** Search mentions by name (for autocomplete). */
	searchMentions(query: string): readonly MentionDefinition[];

	/** Reload custom mentions from .forge/mentions.json. */
	reloadCustomMentions(): Promise<void>;
}

// --- Built-in Mention Definitions ---

const BUILT_IN_MENTIONS: readonly MentionDefinition[] = [
	{ type: 'file', name: 'file', description: 'Full contents of a specific file', syntax: '@file <path>', hasArgument: true, argumentHint: 'File path', isBuiltIn: true },
	{ type: 'folder', name: 'folder', description: 'File tree and summary of a directory', syntax: '@folder <path>', hasArgument: true, argumentHint: 'Folder path', isBuiltIn: true },
	{ type: 'symbol', name: 'symbol', description: 'Definition of a function, class, or type', syntax: '@symbol <name>', hasArgument: true, argumentHint: 'Symbol name', isBuiltIn: true },
	{ type: 'selection', name: 'selection', description: 'Currently selected text in the editor', syntax: '@selection', hasArgument: false, isBuiltIn: true },
	{ type: 'active', name: 'active', description: 'The currently open/focused file', syntax: '@active', hasArgument: false, isBuiltIn: true },
	{ type: 'open', name: 'open', description: 'All currently open tabs', syntax: '@open', hasArgument: false, isBuiltIn: true },
	{ type: 'git-diff', name: 'git-diff', description: 'Current unstaged git diff', syntax: '@git-diff', hasArgument: false, isBuiltIn: true },
	{ type: 'git-staged', name: 'git-staged', description: 'Currently staged changes', syntax: '@git-staged', hasArgument: false, isBuiltIn: true },
	{ type: 'git-log', name: 'git-log', description: 'Last N commit messages and diffs', syntax: '@git-log <n>', hasArgument: true, argumentHint: 'Number of commits', isBuiltIn: true },
	{ type: 'terminal', name: 'terminal', description: 'Recent terminal output (last 100 lines)', syntax: '@terminal', hasArgument: false, isBuiltIn: true },
	{ type: 'errors', name: 'errors', description: 'All current diagnostics (errors + warnings)', syntax: '@errors', hasArgument: false, isBuiltIn: true },
	{ type: 'tests', name: 'tests', description: 'Test files related to the current file', syntax: '@tests', hasArgument: false, isBuiltIn: true },
	{ type: 'docs', name: 'docs', description: 'README and documentation files', syntax: '@docs', hasArgument: false, isBuiltIn: true },
	{ type: 'deps', name: 'deps', description: 'Project dependency files (package.json, etc.)', syntax: '@deps', hasArgument: false, isBuiltIn: true },
	{ type: 'recent', name: 'recent', description: 'Files modified in the last 24 hours', syntax: '@recent', hasArgument: false, isBuiltIn: true },
	{ type: 'search', name: 'search', description: 'Semantic search results from the codebase index', syntax: '@search <query>', hasArgument: true, argumentHint: 'Search query', isBuiltIn: true },
	{ type: 'url', name: 'url', description: 'Fetched content from a web URL', syntax: '@url <url>', hasArgument: true, argumentHint: 'URL', isBuiltIn: true },
	{ type: 'image', name: 'image', description: 'Attach a screenshot or image', syntax: '@image', hasArgument: false, isBuiltIn: true },
	{ type: 'project', name: 'project', description: 'Project-level summary (tech stack, structure)', syntax: '@project', hasArgument: false, isBuiltIn: true },
];

// --- Service Implementation ---

export class ForgeMentionRegistry extends Disposable implements IForgeMentionRegistry {
	declare readonly _serviceBrand: undefined;

	private _customMentions: MentionDefinition[] = [];

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	getAllMentions(): readonly MentionDefinition[] {
		return [...BUILT_IN_MENTIONS, ...this._customMentions];
	}

	getBuiltInMentions(): readonly MentionDefinition[] {
		return BUILT_IN_MENTIONS;
	}

	getCustomMentions(): readonly MentionDefinition[] {
		return this._customMentions;
	}

	searchMentions(query: string): readonly MentionDefinition[] {
		const lowerQuery = query.toLowerCase();
		return this.getAllMentions().filter(m =>
			m.name.toLowerCase().includes(lowerQuery) ||
			m.description.toLowerCase().includes(lowerQuery)
		);
	}

	async reloadCustomMentions(): Promise<void> {
		const workspace = this.workspaceService.getWorkspace();
		const projectRoot = workspace.folders[0]?.uri;
		if (!projectRoot) {
			this._customMentions = [];
			return;
		}

		const mentionsUri = URI.joinPath(projectRoot, '.forge', 'mentions.json');
		try {
			const exists = await this.fileService.exists(mentionsUri);
			if (!exists) {
				this._customMentions = [];
				return;
			}

			const content = await this.fileService.readFile(mentionsUri);
			const parsed = JSON.parse(content.value.toString());

			if (!parsed.mentions || !Array.isArray(parsed.mentions)) {
				this._customMentions = [];
				return;
			}

			this._customMentions = (parsed.mentions as CustomMentionDefinition[]).map(m => ({
				type: 'custom' as MentionType,
				name: m.name,
				description: m.description,
				syntax: `@${m.name}`,
				hasArgument: false,
				isBuiltIn: false,
			}));

			this.logService.info(`[Forge] Loaded ${this._customMentions.length} custom mentions`);
		} catch (e) {
			this.logService.warn(`[Forge] Failed to load custom mentions: ${e}`);
			this._customMentions = [];
		}
	}
}

registerSingleton(IForgeMentionRegistry, ForgeMentionRegistry, InstantiationType.Delayed);
