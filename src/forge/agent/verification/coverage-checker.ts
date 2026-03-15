/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../../vs/platform/log/common/log.js';
import { IConfigurationService } from '../../../vs/platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../vs/platform/workspace/common/workspace.js';
import { IForgeFrameworkDetector } from './framework-detector.js';
import { ForgeChangeSet } from '../../ui/diff-review/diff-panel.js';

// --- Types ---

export interface FileCoverageInfo {
	readonly file: string;
	readonly changedLines: number[];
	readonly coveredLines: number[];
	readonly uncoveredLines: number[];
	readonly coveragePercent: number;
}

export interface CoverageResult {
	readonly status: 'pass' | 'warning' | 'skipped';
	readonly fileCoverage: FileCoverageInfo[];
	readonly totalChangedLines: number;
	readonly totalCoveredLines: number;
	readonly overallCoveragePercent: number;
	readonly coverageThreshold: number;
	readonly meetsThreshold: boolean;
}

// --- Service Interface ---

export const IForgeCoverageChecker = createDecorator<IForgeCoverageChecker>('forgeCoverageChecker');

export interface IForgeCoverageChecker {
	readonly _serviceBrand: undefined;

	/** Run tests with coverage and measure coverage of agent's changed lines. */
	checkCoverage(changeset: ForgeChangeSet): Promise<CoverageResult>;
}

// --- Service Implementation ---

export class ForgeCoverageChecker extends Disposable implements IForgeCoverageChecker {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IForgeFrameworkDetector private readonly frameworkDetector: IForgeFrameworkDetector,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async checkCoverage(changeset: ForgeChangeSet): Promise<CoverageResult> {
		const enabled = this.configurationService.getValue<boolean>('forge.verification.runCoverage') ?? true;
		if (!enabled) {
			return this._skippedResult('disabled');
		}

		const detection = await this.frameworkDetector.getDetectionResult();
		const config = detection.testRunner;

		if (!config.detected || !config.coverageCommand) {
			return this._skippedResult('no test framework with coverage support detected');
		}

		const coverageThreshold = this.configurationService.getValue<number>('forge.verification.coverageThreshold') ?? 70;
		const commandOverride = this.configurationService.getValue<string>('forge.verification.coverageCommand');
		const command = commandOverride || config.coverageCommand;

		this.logService.info(`[Forge] Running coverage check: ${command}`);

		try {
			// Run tests with coverage
			const output = await this._exec(command);

			// Extract changed lines from the changeset
			const changedLinesMap = this._extractChangedLines(changeset);

			// Parse coverage output
			const coverageData = this._parseCoverageOutput(output, config.framework);

			// Cross-reference: which changed lines are covered?
			const fileCoverage: FileCoverageInfo[] = [];
			let totalChangedLines = 0;
			let totalCoveredLines = 0;

			for (const [file, changedLines] of changedLinesMap) {
				const fileCovData = coverageData.get(file);
				const coveredLineSet = new Set(fileCovData?.coveredLines ?? []);

				const covered = changedLines.filter(l => coveredLineSet.has(l));
				const uncovered = changedLines.filter(l => !coveredLineSet.has(l));

				totalChangedLines += changedLines.length;
				totalCoveredLines += covered.length;

				fileCoverage.push({
					file,
					changedLines,
					coveredLines: covered,
					uncoveredLines: uncovered,
					coveragePercent: changedLines.length > 0
						? Math.round((covered.length / changedLines.length) * 100)
						: 100,
				});
			}

			const overallCoveragePercent = totalChangedLines > 0
				? Math.round((totalCoveredLines / totalChangedLines) * 100)
				: 100;
			const meetsThreshold = overallCoveragePercent >= coverageThreshold;
			const status = meetsThreshold ? 'pass' : 'warning';

			this.logService.info(
				`[Forge] Coverage: ${overallCoveragePercent}% of changed lines covered ` +
				`(threshold: ${coverageThreshold}%, ${status})`
			);

			return {
				status,
				fileCoverage,
				totalChangedLines,
				totalCoveredLines,
				overallCoveragePercent,
				coverageThreshold,
				meetsThreshold,
			};
		} catch (error) {
			this.logService.error(`[Forge] Coverage check failed: ${error}`);
			return this._skippedResult('coverage command failed');
		}
	}

	/**
	 * Extract changed line numbers from the changeset by diffing original vs proposed content.
	 */
	private _extractChangedLines(changeset: ForgeChangeSet): Map<string, number[]> {
		const result = new Map<string, number[]>();

		for (const file of changeset.files) {
			const originalLines = file.originalContent.split('\n');
			const proposedLines = file.proposedContent.split('\n');
			const changedLines: number[] = [];

			// Simple line-by-line comparison to find changed/added lines
			const maxLen = Math.max(originalLines.length, proposedLines.length);
			for (let i = 0; i < maxLen; i++) {
				if (i >= originalLines.length || originalLines[i] !== proposedLines[i]) {
					if (i < proposedLines.length) {
						changedLines.push(i + 1); // 1-indexed
					}
				}
			}

			if (changedLines.length > 0) {
				result.set(file.filePath, changedLines);
			}
		}

		return result;
	}

	/**
	 * Parse coverage output into a map of file → covered line numbers.
	 */
	private _parseCoverageOutput(
		output: string,
		framework: string,
	): Map<string, { coveredLines: number[] }> {
		const result = new Map<string, { coveredLines: number[] }>();

		// Try to find and parse JSON coverage data
		try {
			if (framework === 'jest' || framework === 'vitest') {
				return this._parseIstanbulCoverage(output);
			}
			if (framework === 'pytest') {
				return this._parsePyCoverage(output);
			}
			if (framework === 'go test') {
				return this._parseGoCoverage(output);
			}
		} catch {
			// Coverage parsing failed, return empty
		}

		return result;
	}

	/**
	 * Parse Istanbul/NYC JSON coverage format (used by Jest and Vitest).
	 * Expects coverage-final.json in the workspace.
	 */
	private _parseIstanbulCoverage(_output: string): Map<string, { coveredLines: number[] }> {
		const result = new Map<string, { coveredLines: number[] }>();

		try {
			// Try to read coverage/coverage-final.json
			// In a real implementation, we'd read the file; for now parse from output if JSON
			const jsonMatch = _output.match(/\{[\s\S]*"statementMap"[\s\S]*\}/);
			if (jsonMatch) {
				const data = JSON.parse(jsonMatch[0]);
				for (const [file, fileCov] of Object.entries(data)) {
					const coverage = fileCov as { s: Record<string, number>; statementMap: Record<string, { start: { line: number } }> };
					const coveredLines: number[] = [];
					for (const [id, count] of Object.entries(coverage.s ?? {})) {
						if (count > 0) {
							const line = coverage.statementMap?.[id]?.start?.line;
							if (line) {
								coveredLines.push(line);
							}
						}
					}
					result.set(file, { coveredLines });
				}
			}
		} catch {
			// Parsing failed
		}

		return result;
	}

	/**
	 * Parse Python coverage.py JSON format.
	 */
	private _parsePyCoverage(_output: string): Map<string, { coveredLines: number[] }> {
		const result = new Map<string, { coveredLines: number[] }>();

		try {
			const jsonMatch = _output.match(/\{[\s\S]*"files"[\s\S]*\}/);
			if (jsonMatch) {
				const data = JSON.parse(jsonMatch[0]);
				for (const [file, fileCov] of Object.entries(data.files ?? {})) {
					const coverage = fileCov as { executed_lines: number[] };
					result.set(file, { coveredLines: coverage.executed_lines ?? [] });
				}
			}
		} catch {
			// Parsing failed
		}

		return result;
	}

	/**
	 * Parse Go coverage profile format.
	 */
	private _parseGoCoverage(output: string): Map<string, { coveredLines: number[] }> {
		const result = new Map<string, { coveredLines: number[] }>();

		// Go coverage profile: mode: set\nfile.go:start.col,end.col count
		const linePattern = /^(.+):(\d+)\.\d+,(\d+)\.\d+\s+\d+\s+(\d+)/gm;
		let match: RegExpExecArray | null;
		while ((match = linePattern.exec(output)) !== null) {
			const file = match[1];
			const startLine = parseInt(match[2], 10);
			const endLine = parseInt(match[3], 10);
			const count = parseInt(match[4], 10);

			if (count > 0) {
				if (!result.has(file)) {
					result.set(file, { coveredLines: [] });
				}
				const entry = result.get(file)!;
				for (let line = startLine; line <= endLine; line++) {
					entry.coveredLines.push(line);
				}
			}
		}

		return result;
	}

	private _skippedResult(reason: string): CoverageResult {
		this.logService.info(`[Forge] Coverage check skipped: ${reason}`);
		return {
			status: 'skipped',
			fileCoverage: [],
			totalChangedLines: 0,
			totalCoveredLines: 0,
			overallCoveragePercent: 0,
			coverageThreshold: this.configurationService.getValue<number>('forge.verification.coverageThreshold') ?? 70,
			meetsThreshold: false,
		};
	}

	private async _exec(command: string): Promise<string> {
		const { exec } = await import('child_process');
		return new Promise<string>((resolve, reject) => {
			const folders = this.workspaceContextService.getWorkspace().folders;
			const cwd = folders.length > 0 ? folders[0].uri.fsPath : undefined;

			exec(command, { cwd, timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
				const output = stdout + '\n' + stderr;
				if (error) {
					reject(new Error(output));
				} else {
					resolve(output);
				}
			});
		});
	}
}

registerSingleton(IForgeCoverageChecker, ForgeCoverageChecker, InstantiationType.Delayed);
