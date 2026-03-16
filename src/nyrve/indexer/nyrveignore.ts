/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../vs/base/common/uri.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { IFileService } from '../../vs/platform/files/common/files.js';
import { IWorkspaceContextService } from '../../vs/platform/workspace/common/workspace.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';

// --- Default Ignore Patterns ---

const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
	'node_modules/',
	'.git/',
	'dist/',
	'build/',
	'out/',
	'.next/',
	'.nuxt/',
	'coverage/',
	'__pycache__/',
	'.pytest_cache/',
	'.mypy_cache/',
	'target/',
	'vendor/',
	'.venv/',
	'venv/',
	'.env',
	'.env.*',
	'*.min.js',
	'*.min.css',
	'*.map',
	'*.lock',
	'package-lock.json',
	'yarn.lock',
	'pnpm-lock.yaml',
	'*.png',
	'*.jpg',
	'*.jpeg',
	'*.gif',
	'*.ico',
	'*.svg',
	'*.woff',
	'*.woff2',
	'*.ttf',
	'*.eot',
	'*.mp3',
	'*.mp4',
	'*.webm',
	'*.pdf',
	'*.zip',
	'*.tar',
	'*.gz',
	'*.exe',
	'*.dll',
	'*.so',
	'*.dylib',
	'*.wasm',
	'*.pyc',
	'*.class',
	'*.o',
	'*.obj',
	'.DS_Store',
	'Thumbs.db',
];

// --- Service Interface ---

export const INyrveIgnoreService = createDecorator<INyrveIgnoreService>('nyrveIgnoreService');

export interface INyrveIgnoreService {
	readonly _serviceBrand: undefined;

	/** Check if a file path should be excluded from indexing. */
	isIgnored(filePath: string): boolean;

	/** Reload ignore patterns from .nyrveignore and .gitignore files. */
	reload(): Promise<void>;

	/** Get all active ignore patterns. */
	getPatterns(): readonly string[];

	/** Check if a file exceeds the max file size for indexing. */
	exceedsMaxFileSize(fileSizeBytes: number): boolean;
}

// --- Service Implementation ---

export class NyrveIgnoreService extends Disposable implements INyrveIgnoreService {
	declare readonly _serviceBrand: undefined;

	private _patterns: string[] = [];
	private _compiledPatterns: Array<{ pattern: string; regex: RegExp; negate: boolean }> = [];

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._patterns = [...DEFAULT_IGNORE_PATTERNS];
		this._compilePatterns();
	}

	isIgnored(filePath: string): boolean {
		// Normalize path separators
		const normalized = filePath.replace(/\\/g, '/');

		let ignored = false;
		for (const entry of this._compiledPatterns) {
			if (entry.regex.test(normalized)) {
				ignored = !entry.negate;
			}
		}
		return ignored;
	}

	async reload(): Promise<void> {
		const patterns: string[] = [...DEFAULT_IGNORE_PATTERNS];
		const workspace = this.workspaceService.getWorkspace();
		const projectRoot = workspace.folders[0]?.uri;

		if (!projectRoot) {
			this._patterns = patterns;
			this._compilePatterns();
			return;
		}

		// Load .gitignore
		const gitignorePatterns = await this._loadIgnoreFile(URI.joinPath(projectRoot, '.gitignore'));
		patterns.push(...gitignorePatterns);

		// Load .nyrveignore (overrides)
		const nyrveignorePatterns = await this._loadIgnoreFile(URI.joinPath(projectRoot, '.nyrveignore'));
		patterns.push(...nyrveignorePatterns);

		this._patterns = patterns;
		this._compilePatterns();

		this.logService.info(`[Nyrve] Loaded ${patterns.length} ignore patterns`);
	}

	getPatterns(): readonly string[] {
		return this._patterns;
	}

	exceedsMaxFileSize(fileSizeBytes: number): boolean {
		const maxSize = this.configurationService.getValue<number>('nyrve.indexer.maxFileSize') ?? 1048576;
		return fileSizeBytes > maxSize;
	}

	private async _loadIgnoreFile(uri: URI): Promise<string[]> {
		try {
			const exists = await this.fileService.exists(uri);
			if (!exists) {
				return [];
			}
			const content = await this.fileService.readFile(uri);
			return this._parseIgnoreContent(content.value.toString());
		} catch {
			return [];
		}
	}

	private _parseIgnoreContent(content: string): string[] {
		return content
			.split('\n')
			.map(line => line.trim())
			.filter(line => line.length > 0 && !line.startsWith('#'));
	}

	private _compilePatterns(): void {
		this._compiledPatterns = this._patterns.map(pattern => {
			const negate = pattern.startsWith('!');
			const raw = negate ? pattern.slice(1) : pattern;
			const regex = this._patternToRegex(raw);
			return { pattern, regex, negate };
		});
	}

	/**
	 * Convert a gitignore-style glob pattern to a RegExp.
	 * Supports: `*`, `**`, `?`, and directory trailing `/`.
	 */
	private _patternToRegex(pattern: string): RegExp {
		let regexStr = pattern
			.replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex specials (except * and ?)
			.replace(/\*\*/g, '{{GLOBSTAR}}')       // Preserve **
			.replace(/\*/g, '[^/]*')                 // * matches non-slash
			.replace(/\?/g, '[^/]')                  // ? matches single non-slash
			.replace(/\{\{GLOBSTAR\}\}/g, '.*');     // ** matches everything

		// If pattern ends with /, match directories (any path starting with this)
		if (pattern.endsWith('/')) {
			regexStr = '(^|/)' + regexStr;
		} else {
			// Match as filename or full path
			regexStr = '(^|/)' + regexStr + '($|/)';
		}

		return new RegExp(regexStr);
	}
}

registerSingleton(INyrveIgnoreService, NyrveIgnoreService, InstantiationType.Delayed);
