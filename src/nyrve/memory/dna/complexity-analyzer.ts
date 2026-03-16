/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../vs/platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../vs/platform/workspace/common/workspace.js';
import { INyrveIndexManager } from '../../indexer/index-manager.js';

// --- Types ---

export interface TechDebtItem {
	readonly type: 'todo' | 'fixme' | 'hack' | 'deprecated' | 'workaround';
	readonly file: string;
	readonly line: number;
	readonly comment: string;
	readonly age: string;
	readonly author: string;
}

export interface ComplexityResult {
	readonly largestFiles: Array<{ path: string; lines: number }>;
	readonly mostComplexFunctions: Array<{ path: string; name: string; cyclomaticComplexity: number }>;
	readonly techDebt: TechDebtItem[];
}

// --- Analyzer ---

export class NyrveComplexityAnalyzer {
	constructor(
		private readonly indexManager: INyrveIndexManager,
		private readonly workspaceContextService: IWorkspaceContextService,
		private readonly logService: ILogService,
	) {}

	async analyze(): Promise<ComplexityResult> {
		this.logService.info('[Nyrve] Complexity analyzer: scanning for tech debt and complexity...');

		const [largestFiles, techDebt, complexFunctions] = await Promise.all([
			this._findLargestFiles(),
			this._findTechDebt(),
			this._findComplexFunctions(),
		]);

		this.logService.info(
			`[Nyrve] Complexity analyzer: ${largestFiles.length} large files, ` +
			`${techDebt.length} debt items, ${complexFunctions.length} complex functions`
		);

		return {
			largestFiles,
			mostComplexFunctions: complexFunctions,
			techDebt,
		};
	}

	private _findLargestFiles(): Array<{ path: string; lines: number }> {
		const allFiles = this.indexManager.searchFiles('');
		const filesBySize: Array<{ path: string; lines: number }> = [];

		for (const filePath of allFiles) {
			const entry = this.indexManager.getFileEntry(filePath);
			if (entry) {
				filesBySize.push({ path: filePath, lines: entry.lineCount });
			}
		}

		filesBySize.sort((a, b) => b.lines - a.lines);
		return filesBySize.slice(0, 15);
	}

	private async _findTechDebt(): Promise<TechDebtItem[]> {
		const cwd = this._getCwd();
		if (!cwd) {
			return [];
		}

		const debtItems: TechDebtItem[] = [];
		const patterns: Array<{ regex: RegExp; type: TechDebtItem['type'] }> = [
			{ regex: /\/\/\s*TODO[:\s](.+)/i, type: 'todo' },
			{ regex: /\/\/\s*FIXME[:\s](.+)/i, type: 'fixme' },
			{ regex: /\/\/\s*HACK[:\s](.+)/i, type: 'hack' },
			{ regex: /#\s*TODO[:\s](.+)/i, type: 'todo' },
			{ regex: /#\s*FIXME[:\s](.+)/i, type: 'fixme' },
			{ regex: /#\s*HACK[:\s](.+)/i, type: 'hack' },
			{ regex: /\/\/\s*@deprecated/i, type: 'deprecated' },
			{ regex: /\/\/\s*WORKAROUND[:\s](.+)/i, type: 'workaround' },
		];

		try {
			// Use grep to find TODO/FIXME/HACK comments
			for (const { regex, type } of patterns) {
				const keyword = type.toUpperCase();
				const output = await this._exec(
					`git grep -n "${keyword}" -- '*.ts' '*.js' '*.py' '*.go' '*.rs' '*.rb' 2>/dev/null | head -50`,
					cwd,
				);

				for (const line of output.split('\n')) {
					if (!line.trim()) {
						continue;
					}

					const colonIdx = line.indexOf(':');
					const secondColonIdx = line.indexOf(':', colonIdx + 1);
					if (colonIdx < 0 || secondColonIdx < 0) {
						continue;
					}

					const file = line.slice(0, colonIdx);
					const lineNum = parseInt(line.slice(colonIdx + 1, secondColonIdx), 10);
					const content = line.slice(secondColonIdx + 1).trim();

					const match = regex.exec(content);
					const comment = match?.[1]?.trim() ?? content;

					// Get git blame for age
					let age = 'unknown';
					let author = 'unknown';
					try {
						const blame = await this._exec(
							`git blame -L ${lineNum},${lineNum} --porcelain "${file}" 2>/dev/null | head -5`,
							cwd,
						);
						const timeMatch = blame.match(/author-time\s+(\d+)/);
						const authorMatch = blame.match(/author\s+(.+)/);
						if (timeMatch) {
							const date = new Date(parseInt(timeMatch[1], 10) * 1000);
							const daysDiff = Math.floor((Date.now() - date.getTime()) / (86400 * 1000));
							age = daysDiff > 365 ? `${Math.floor(daysDiff / 365)}y ago`
								: daysDiff > 30 ? `${Math.floor(daysDiff / 30)}mo ago`
									: `${daysDiff}d ago`;
						}
						if (authorMatch) {
							author = authorMatch[1].trim();
						}
					} catch {
						// git blame failed, keep defaults
					}

					debtItems.push({ type, file, line: lineNum, comment, age, author });
				}
			}
		} catch {
			// grep failed, return empty
		}

		return debtItems.slice(0, 50);
	}

	private _findComplexFunctions(): Array<{ path: string; name: string; cyclomaticComplexity: number }> {
		// Use the index to find large functions (heuristic for complexity)
		const allFiles = this.indexManager.searchFiles('');
		const complexFunctions: Array<{ path: string; name: string; cyclomaticComplexity: number }> = [];

		for (const filePath of allFiles) {
			const symbols = this.indexManager.getFileSymbols(filePath);
			for (const sym of symbols) {
				if (sym.kind === 'function' || sym.kind === 'method') {
					const lineSpan = sym.lineEnd - sym.lineStart;
					// Rough cyclomatic complexity estimate based on function length
					// A real implementation would parse the AST
					const estimatedComplexity = Math.max(1, Math.floor(lineSpan / 5));
					if (estimatedComplexity > 10) {
						complexFunctions.push({
							path: filePath,
							name: sym.containerName ? `${sym.containerName}.${sym.name}` : sym.name,
							cyclomaticComplexity: estimatedComplexity,
						});
					}
				}
			}
		}

		return complexFunctions
			.sort((a, b) => b.cyclomaticComplexity - a.cyclomaticComplexity)
			.slice(0, 15);
	}

	private _getCwd(): string | undefined {
		const folders = this.workspaceContextService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri.fsPath : undefined;
	}

	private async _exec(command: string, cwd: string): Promise<string> {
		const { exec } = await import('child_process');
		return new Promise<string>((resolve, reject) => {
			exec(command, { cwd, timeout: 30000, maxBuffer: 5 * 1024 * 1024 }, (error, stdout) => {
				if (error) {
					reject(error);
				} else {
					resolve(stdout);
				}
			});
		});
	}
}
