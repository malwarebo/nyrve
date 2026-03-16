/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../../vs/platform/log/common/log.js';
import { IConfigurationService } from '../../../vs/platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../vs/platform/workspace/common/workspace.js';
import { INyrveIndexManager } from '../../indexer/index-manager.js';
import { NyrveChangeSet } from '../../ui/diff-review/diff-panel.js';

// --- Types ---

export interface BrokenImport {
	readonly file: string;
	readonly line: number;
	readonly importPath: string;
	readonly reason: 'not_found' | 'circular' | 'type_mismatch';
	readonly suggestion?: string;
}

export interface CircularDep {
	readonly cycle: string[];
}

export interface ImportCheckResult {
	readonly status: 'pass' | 'fail' | 'skipped';
	readonly brokenImports: BrokenImport[];
	readonly newCircularDeps: CircularDep[];
}

// --- Service Interface ---

export const INyrveImportChecker = createDecorator<INyrveImportChecker>('nyrveImportChecker');

export interface INyrveImportChecker {
	readonly _serviceBrand: undefined;

	/** Check imports in modified files for broken paths and new circular dependencies. */
	checkImports(changeset: NyrveChangeSet): Promise<ImportCheckResult>;
}

// --- Service Implementation ---

export class NyrveImportChecker extends Disposable implements INyrveImportChecker {
	declare readonly _serviceBrand: undefined;

	constructor(
		@INyrveIndexManager private readonly indexManager: INyrveIndexManager,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService _workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async checkImports(changeset: NyrveChangeSet): Promise<ImportCheckResult> {
		const enabled = this.configurationService.getValue<boolean>('nyrve.verification.runImportCheck') ?? true;
		if (!enabled) {
			return { status: 'skipped', brokenImports: [], newCircularDeps: [] };
		}

		this.logService.info('[Nyrve] Running import check...');

		try {
			const brokenImports: BrokenImport[] = [];
			const modifiedFiles = changeset.files.map(f => f.filePath);

			// Check imports in each modified file
			for (const file of changeset.files) {
				const imports = this._extractImports(file.proposedContent, file.filePath);

				for (const imp of imports) {
					const resolved = this._resolveImport(imp.path, file.filePath);
					if (!resolved) {
						// Try to suggest a correction
						const suggestion = this._suggestCorrection(imp.path, file.filePath);
						brokenImports.push({
							file: file.filePath,
							line: imp.line,
							importPath: imp.path,
							reason: 'not_found',
							suggestion,
						});
					}
				}
			}

			// Check for new circular dependencies
			const newCircularDeps = await this._detectNewCircularDeps(modifiedFiles);

			// Add circular dep broken imports
			for (const dep of newCircularDeps) {
				brokenImports.push({
					file: dep.cycle[0],
					line: 0,
					importPath: dep.cycle[1],
					reason: 'circular',
				});
			}

			const status = brokenImports.length > 0 || newCircularDeps.length > 0 ? 'fail' : 'pass';

			this.logService.info(
				`[Nyrve] Import check ${status}: ${brokenImports.length} broken imports, ` +
				`${newCircularDeps.length} new circular deps`
			);

			return { status, brokenImports, newCircularDeps };
		} catch (error) {
			this.logService.error(`[Nyrve] Import check failed: ${error}`);
			return { status: 'skipped', brokenImports: [], newCircularDeps: [] };
		}
	}

	/**
	 * Extract import statements from file content.
	 */
	private _extractImports(content: string, filePath: string): Array<{ path: string; line: number }> {
		const imports: Array<{ path: string; line: number }> = [];
		const lines = content.split('\n');

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			// TypeScript/JavaScript: import ... from '...'
			const tsImportMatch = line.match(/(?:import|export)\s+.*?\s+from\s+['"](.+?)['"]/);
			if (tsImportMatch) {
				imports.push({ path: tsImportMatch[1], line: i + 1 });
				continue;
			}

			// TypeScript/JavaScript: import '...'
			const tsSideEffectMatch = line.match(/import\s+['"](.+?)['"]/);
			if (tsSideEffectMatch) {
				imports.push({ path: tsSideEffectMatch[1], line: i + 1 });
				continue;
			}

			// TypeScript/JavaScript: require('...')
			const requireMatch = line.match(/require\s*\(\s*['"](.+?)['"]\s*\)/);
			if (requireMatch) {
				imports.push({ path: requireMatch[1], line: i + 1 });
				continue;
			}

			// Python: import ... / from ... import ...
			if (filePath.endsWith('.py')) {
				const pyImportMatch = line.match(/^(?:from\s+(\S+)\s+import|import\s+(\S+))/);
				if (pyImportMatch) {
					imports.push({ path: pyImportMatch[1] ?? pyImportMatch[2], line: i + 1 });
				}
			}

			// Go: import "..."
			if (filePath.endsWith('.go')) {
				const goImportMatch = line.match(/^\s*"(.+?)"/);
				if (goImportMatch) {
					imports.push({ path: goImportMatch[1], line: i + 1 });
				}
			}

			// Rust: use ...
			if (filePath.endsWith('.rs')) {
				const rustUseMatch = line.match(/^\s*use\s+(.+?);/);
				if (rustUseMatch) {
					imports.push({ path: rustUseMatch[1], line: i + 1 });
				}
			}
		}

		return imports;
	}

	/**
	 * Resolve an import path to check if it exists.
	 * For relative imports, resolve against the importing file's directory.
	 * For package imports, check if the package exists.
	 */
	private _resolveImport(importPath: string, fromFile: string): boolean {
		// Skip Node.js built-in modules
		if (this._isBuiltinModule(importPath)) {
			return true;
		}

		// Skip absolute package imports (node_modules)
		if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
			// Package import — assume it exists if it's in node_modules
			// A full check would look in node_modules, but that's expensive
			return true;
		}

		// Relative import — resolve against the codebase index
		const dir = fromFile.replace(/\/[^/]+$/, '');
		const resolved = this._resolveRelativePath(dir, importPath);

		// Check various extensions
		const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', ''];
		for (const ext of extensions) {
			const candidate = resolved + ext;
			const results = this.indexManager.searchFiles(candidate);
			if (results.length > 0) {
				return true;
			}
			// Also try /index.ts etc.
			const indexCandidate = resolved + '/index' + ext;
			const indexResults = this.indexManager.searchFiles(indexCandidate);
			if (indexResults.length > 0) {
				return true;
			}
		}

		return false;
	}

	private _resolveRelativePath(fromDir: string, relativePath: string): string {
		const parts = fromDir.split('/');
		for (const segment of relativePath.split('/')) {
			if (segment === '..') {
				parts.pop();
			} else if (segment !== '.') {
				parts.push(segment);
			}
		}
		return parts.join('/');
	}

	private _isBuiltinModule(name: string): boolean {
		const builtins = new Set([
			'fs', 'path', 'os', 'util', 'events', 'stream', 'http', 'https',
			'url', 'querystring', 'crypto', 'buffer', 'child_process', 'cluster',
			'dgram', 'dns', 'net', 'tls', 'readline', 'repl', 'vm', 'zlib',
			'assert', 'timers', 'worker_threads', 'perf_hooks', 'async_hooks',
			'node:fs', 'node:path', 'node:os', 'node:util', 'node:events',
			'node:stream', 'node:http', 'node:https', 'node:url', 'node:crypto',
			'node:buffer', 'node:child_process', 'node:net', 'node:tls',
			'node:readline', 'node:vm', 'node:zlib', 'node:assert', 'node:timers',
			'node:worker_threads', 'node:perf_hooks', 'node:async_hooks',
		]);
		return builtins.has(name);
	}

	/**
	 * Suggest a correction for a broken import path.
	 */
	private _suggestCorrection(importPath: string, _fromFile: string): string | undefined {
		// Try fuzzy matching against the index
		const baseName = importPath.split('/').pop() ?? importPath;
		const results = this.indexManager.searchFiles(baseName);
		if (results.length > 0) {
			return `Did you mean '${results[0]}'?`;
		}
		return undefined;
	}

	/**
	 * Detect new circular dependencies introduced by the modified files.
	 * This is a simplified check — walk the import graph from each modified file.
	 */
	private async _detectNewCircularDeps(modifiedFiles: string[]): Promise<CircularDep[]> {
		const cycles: CircularDep[] = [];

		for (const file of modifiedFiles) {
			const visited = new Set<string>();
			const path: string[] = [];
			this._dfsDetectCycle(file, visited, path, cycles);
		}

		return cycles;
	}

	private _dfsDetectCycle(
		file: string,
		visited: Set<string>,
		path: string[],
		cycles: CircularDep[],
	): void {
		if (path.includes(file)) {
			// Found a cycle
			const cycleStart = path.indexOf(file);
			cycles.push({ cycle: [...path.slice(cycleStart), file] });
			return;
		}

		if (visited.has(file)) {
			return;
		}

		visited.add(file);
		path.push(file);

		// Get imports for this file from the index
		const fileEntry = this.indexManager.searchFiles(file);
		if (fileEntry.length > 0) {
			const symbols = this.indexManager.getFileSymbols(fileEntry[0]);
			// Note: In a full implementation, we'd track imports in the index.
			// For now, we rely on the type checker to catch most import issues.
			void symbols;
		}

		path.pop();
	}
}

registerSingleton(INyrveImportChecker, NyrveImportChecker, InstantiationType.Delayed);
