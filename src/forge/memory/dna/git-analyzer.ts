/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../vs/platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../vs/platform/workspace/common/workspace.js';

// --- Types ---

export interface FileHotspot {
	readonly path: string;
	readonly changeCount: number;
	readonly lastChanged: string;
	readonly topChangers: string[];
}

export interface FileCoupling {
	readonly fileA: string;
	readonly fileB: string;
	readonly couplingStrength: number;
	readonly coChangeCount: number;
}

export interface GitAnalysisResult {
	readonly totalCommits: number;
	readonly activeContributors: number;
	readonly hotspots: FileHotspot[];
	readonly couplings: FileCoupling[];
	readonly churnRate: number;
	readonly branchStrategy: string;
}

// --- Analyzer ---

export class ForgeGitAnalyzer {
	constructor(
		private readonly workspaceContextService: IWorkspaceContextService,
		private readonly logService: ILogService,
	) {}

	async analyze(historyDays: number): Promise<GitAnalysisResult> {
		this.logService.info(`[Forge] Git analyzer: analyzing ${historyDays} days of history...`);

		const cwd = this._getCwd();
		if (!cwd) {
			return this._emptyResult();
		}

		try {
			const [hotspots, contributors, totalCommits, couplings, branchStrategy] = await Promise.all([
				this._computeHotspots(cwd, historyDays),
				this._computeContributors(cwd),
				this._countCommits(cwd, historyDays),
				this._computeCouplings(cwd, historyDays),
				this._detectBranchStrategy(cwd),
			]);

			const weeks = historyDays / 7;
			const churnRate = weeks > 0 ? Math.round(totalCommits / weeks) : 0;

			this.logService.info(
				`[Forge] Git analyzer: ${totalCommits} commits, ${contributors} contributors, ` +
				`${hotspots.length} hotspots, ${couplings.length} couplings`
			);

			return {
				totalCommits,
				activeContributors: contributors,
				hotspots,
				couplings,
				churnRate,
				branchStrategy,
			};
		} catch (error) {
			this.logService.error(`[Forge] Git analysis failed: ${error}`);
			return this._emptyResult();
		}
	}

	private async _computeHotspots(cwd: string, days: number): Promise<FileHotspot[]> {
		const since = this._daysAgo(days);

		// git log --numstat to get file change counts
		const output = await this._exec(
			`git log --since="${since}" --pretty=format:"COMMIT:%an:%aI" --numstat`,
			cwd,
		);

		const fileCounts = new Map<string, { count: number; authors: Map<string, number>; lastDate: string }>();
		let currentAuthor = '';
		let currentDate = '';

		for (const line of output.split('\n')) {
			if (line.startsWith('COMMIT:')) {
				const parts = line.split(':');
				currentAuthor = parts[1] ?? '';
				currentDate = parts.slice(2).join(':');
				continue;
			}

			const match = line.match(/^\d+\s+\d+\s+(.+)$/);
			if (match) {
				const file = match[1];
				if (!fileCounts.has(file)) {
					fileCounts.set(file, { count: 0, authors: new Map(), lastDate: '' });
				}
				const entry = fileCounts.get(file)!;
				entry.count++;
				entry.authors.set(currentAuthor, (entry.authors.get(currentAuthor) ?? 0) + 1);
				if (!entry.lastDate || currentDate > entry.lastDate) {
					entry.lastDate = currentDate;
				}
			}
		}

		// Sort by change count and take top 20
		const sorted = [...fileCounts.entries()]
			.sort(([, a], [, b]) => b.count - a.count)
			.slice(0, 20);

		return sorted.map(([path, data]) => ({
			path,
			changeCount: data.count,
			lastChanged: data.lastDate,
			topChangers: [...data.authors.entries()]
				.sort(([, a], [, b]) => b - a)
				.slice(0, 3)
				.map(([name]) => name),
		}));
	}

	private async _computeContributors(cwd: string): Promise<number> {
		const output = await this._exec('git shortlog -sn --no-merges HEAD', cwd);
		return output.split('\n').filter(l => l.trim()).length;
	}

	private async _countCommits(cwd: string, days: number): Promise<number> {
		const since = this._daysAgo(days);
		const output = await this._exec(`git rev-list --count --since="${since}" HEAD`, cwd);
		return parseInt(output.trim(), 10) || 0;
	}

	private async _computeCouplings(cwd: string, days: number): Promise<FileCoupling[]> {
		const since = this._daysAgo(days);

		// Get list of files changed per commit
		const output = await this._exec(
			`git log --since="${since}" --pretty=format:"COMMIT" --name-only`,
			cwd,
		);

		const commits: string[][] = [];
		let currentCommit: string[] = [];

		for (const line of output.split('\n')) {
			if (line === 'COMMIT') {
				if (currentCommit.length > 0) {
					commits.push(currentCommit);
				}
				currentCommit = [];
			} else if (line.trim()) {
				currentCommit.push(line.trim());
			}
		}
		if (currentCommit.length > 0) {
			commits.push(currentCommit);
		}

		// Count co-changes between file pairs
		const pairCounts = new Map<string, number>();
		const fileTotalCounts = new Map<string, number>();

		for (const files of commits) {
			for (const f of files) {
				fileTotalCounts.set(f, (fileTotalCounts.get(f) ?? 0) + 1);
			}
			// Only consider commits with 2-10 files (larger commits are likely refactors)
			if (files.length >= 2 && files.length <= 10) {
				for (let i = 0; i < files.length; i++) {
					for (let j = i + 1; j < files.length; j++) {
						const key = [files[i], files[j]].sort().join('::');
						pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
					}
				}
			}
		}

		// Convert to couplings, filter by minimum co-change count
		const couplings: FileCoupling[] = [];
		for (const [key, count] of pairCounts) {
			if (count >= 3) {
				const [fileA, fileB] = key.split('::');
				const totalA = fileTotalCounts.get(fileA) ?? 1;
				const totalB = fileTotalCounts.get(fileB) ?? 1;
				const strength = count / Math.min(totalA, totalB);

				if (strength >= 0.3) {
					couplings.push({
						fileA,
						fileB,
						couplingStrength: Math.round(strength * 100) / 100,
						coChangeCount: count,
					});
				}
			}
		}

		return couplings.sort((a, b) => b.couplingStrength - a.couplingStrength).slice(0, 20);
	}

	private async _detectBranchStrategy(cwd: string): Promise<string> {
		try {
			const output = await this._exec('git branch -r', cwd);
			const branches = output.split('\n').map(b => b.trim()).filter(b => b);

			const hasMain = branches.some(b => b.includes('/main') || b.includes('/master'));
			const hasDevelop = branches.some(b => b.includes('/develop') || b.includes('/dev'));
			const hasRelease = branches.some(b => b.includes('/release'));
			const featureBranches = branches.filter(b => b.includes('/feature'));

			if (hasDevelop && hasRelease) {
				return 'gitflow';
			}
			if (featureBranches.length > 3) {
				return 'feature-branch';
			}
			if (hasMain && branches.length <= 5) {
				return 'trunk-based';
			}

			return 'feature-branch';
		} catch {
			return 'unknown';
		}
	}

	private _daysAgo(days: number): string {
		const date = new Date();
		date.setDate(date.getDate() - days);
		return date.toISOString().split('T')[0];
	}

	private _getCwd(): string | undefined {
		const folders = this.workspaceContextService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri.fsPath : undefined;
	}

	private async _exec(command: string, cwd: string): Promise<string> {
		const { exec } = await import('child_process');
		return new Promise<string>((resolve, reject) => {
			exec(command, { cwd, timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
				if (error) {
					reject(error);
				} else {
					resolve(stdout);
				}
			});
		});
	}

	private _emptyResult(): GitAnalysisResult {
		return {
			totalCommits: 0,
			activeContributors: 0,
			hotspots: [],
			couplings: [],
			churnRate: 0,
			branchStrategy: 'unknown',
		};
	}
}
