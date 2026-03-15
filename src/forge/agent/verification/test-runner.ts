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
import { IForgeFrameworkDetector, TestRunnerConfig } from './framework-detector.js';
import { IForgeIndexManager } from '../../indexer/index-manager.js';
import { ForgeChangeSet } from '../../ui/diff-review/diff-panel.js';

// --- Types ---

export interface TestCase {
	readonly name: string;
	readonly file: string;
	readonly status: 'passed' | 'failed' | 'skipped';
	readonly duration: number;
	readonly errorMessage?: string;
	readonly errorStack?: string;
}

export interface TestRunSummary {
	readonly total: number;
	readonly passed: number;
	readonly failed: number;
	readonly skipped: number;
	readonly duration: number;
}

export interface TestResult {
	readonly status: 'pass' | 'fail' | 'skipped' | 'no_tests';
	readonly framework: string;
	readonly command: string;
	readonly beforeRun: TestRunSummary;
	readonly afterRun: TestRunSummary;
	readonly regressions: TestCase[];
	readonly relevantTests: TestCase[];
	readonly relevantTestCount: number;
	readonly duration: number;
}

// --- Service Interface ---

export const IForgeTestRunner = createDecorator<IForgeTestRunner>('forgeTestRunner');

export interface IForgeTestRunner {
	readonly _serviceBrand: undefined;

	/** Run tests before and after agent changes. Detect regressions. */
	runTests(changeset: ForgeChangeSet): Promise<TestResult>;
}

// --- Empty results ---

const EMPTY_SUMMARY: TestRunSummary = { total: 0, passed: 0, failed: 0, skipped: 0, duration: 0 };

// --- Service Implementation ---

export class ForgeTestRunner extends Disposable implements IForgeTestRunner {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IForgeFrameworkDetector private readonly frameworkDetector: IForgeFrameworkDetector,
		@IForgeIndexManager private readonly indexManager: IForgeIndexManager,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async runTests(changeset: ForgeChangeSet): Promise<TestResult> {
		const enabled = this.configurationService.getValue<boolean>('forge.verification.runTests') ?? true;
		if (!enabled) {
			return this._skippedResult('disabled');
		}

		const startTime = Date.now();
		const detection = await this.frameworkDetector.getDetectionResult();
		const config = detection.testRunner;

		if (!config.detected) {
			return this._skippedResult('no test framework detected');
		}

		const testTimeout = this.configurationService.getValue<number>('forge.verification.testTimeout') ?? 60000;

		// Allow user to override the auto-detected command
		const commandOverride = this.configurationService.getValue<string>('forge.verification.testCommand');

		this.logService.info(`[Forge] Running tests with ${config.framework}`);

		try {
			// Find relevant test files for the modified source files
			const modifiedFiles = changeset.files.map(f => f.filePath);
			const relevantTestFiles = await this._findRelevantTests(modifiedFiles, config);

			// Build the test command
			const command = commandOverride || (
				relevantTestFiles.length > 0
					? this._buildRelevantTestCommand(config, relevantTestFiles, modifiedFiles)
					: config.command
			);

			// Step 1: Stash agent changes → run tests → capture beforeRun
			await this._exec('git stash push -m "forge-verification-test-baseline"');
			let beforeRun: TestRunSummary;
			let beforeTests: TestCase[];
			try {
				const beforeResult = await this._runTestCommand(command, config.framework, testTimeout);
				beforeRun = beforeResult.summary;
				beforeTests = beforeResult.tests;
			} finally {
				await this._exec('git stash pop');
			}

			// Step 2: Run tests again with agent changes applied → capture afterRun
			const afterResult = await this._runTestCommand(command, config.framework, testTimeout);
			const afterRun = afterResult.summary;
			const afterTests = afterResult.tests;

			// Step 3: Detect regressions (passed before, failed after)
			const regressions = this._detectRegressions(beforeTests, afterTests);

			const duration = Date.now() - startTime;
			const status = regressions.length > 0 ? 'fail' : 'pass';

			this.logService.info(
				`[Forge] Tests ${status}: ${afterRun.passed} passed, ${afterRun.failed} failed, ` +
				`${regressions.length} regressions (${duration}ms)`
			);

			return {
				status,
				framework: config.framework,
				command,
				beforeRun,
				afterRun,
				regressions,
				relevantTests: afterTests.filter(t => relevantTestFiles.some(f => t.file.includes(f))),
				relevantTestCount: relevantTestFiles.length,
				duration,
			};
		} catch (error) {
			this.logService.error(`[Forge] Test run failed: ${error}`);
			return {
				status: 'fail',
				framework: config.framework,
				command: commandOverride || config.command,
				beforeRun: EMPTY_SUMMARY,
				afterRun: EMPTY_SUMMARY,
				regressions: [],
				relevantTests: [],
				relevantTestCount: 0,
				duration: Date.now() - startTime,
			};
		}
	}

	/**
	 * Find test files relevant to the modified source files.
	 * 1. Use codebase index to find test files that import modified files
	 * 2. Fall back to naming conventions
	 */
	private async _findRelevantTests(modifiedFiles: string[], _config: TestRunnerConfig): Promise<string[]> {
		const testFiles: Set<string> = new Set();

		for (const file of modifiedFiles) {
			// Skip test files themselves
			if (this._isTestFile(file)) {
				testFiles.add(file);
				continue;
			}

			// Try to find via naming convention
			const conventions = this._getTestFileConventions(file);
			for (const convention of conventions) {
				const results = this.indexManager.searchFiles(convention);
				for (const result of results) {
					testFiles.add(result);
				}
			}
		}

		return Array.from(testFiles);
	}

	private _isTestFile(filePath: string): boolean {
		return /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath) ||
			/test_.*\.py$/.test(filePath) ||
			/.*_test\.py$/.test(filePath) ||
			/.*_test\.go$/.test(filePath) ||
			/.*\.test\.rb$/.test(filePath);
	}

	private _getTestFileConventions(filePath: string): string[] {
		const conventions: string[] = [];
		const baseName = filePath.replace(/\.[^.]+$/, '');
		const ext = filePath.match(/\.[^.]+$/)?.[0] ?? '';

		// TypeScript/JavaScript conventions
		if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) {
			conventions.push(`${baseName}.test${ext}`);
			conventions.push(`${baseName}.spec${ext}`);
			// __tests__ directory
			const dir = filePath.replace(/\/[^/]+$/, '');
			const fileName = filePath.replace(/.*\//, '');
			conventions.push(`${dir}/__tests__/${fileName}`);
		}

		// Python conventions
		if (filePath.endsWith('.py')) {
			const fileName = filePath.replace(/.*\//, '').replace('.py', '');
			const dir = filePath.replace(/\/[^/]+$/, '');
			conventions.push(`${dir}/test_${fileName}.py`);
			conventions.push(`${dir}/${fileName}_test.py`);
			conventions.push(`tests/${fileName}_test.py`);
		}

		// Go conventions
		if (filePath.endsWith('.go') && !filePath.endsWith('_test.go')) {
			conventions.push(`${baseName}_test.go`);
		}

		return conventions;
	}

	private _buildRelevantTestCommand(config: TestRunnerConfig, testFiles: string[], sourceFiles: string[]): string {
		const template = config.relevantTestCommand;

		if (template.includes('{files}')) {
			return template.replace('{files}', sourceFiles.join(' '));
		}
		if (template.includes('{testFiles}')) {
			return template.replace('{testFiles}', testFiles.join(' '));
		}
		if (template.includes('{packages}')) {
			// Go: derive packages from file paths
			const packages = [...new Set(sourceFiles.map(f => './' + f.replace(/\/[^/]+$/, '') + '/...'))];
			return template.replace('{packages}', packages.join(' '));
		}
		if (template.includes('{testNames}')) {
			return template.replace('{testNames}', testFiles.join(' '));
		}

		return config.command;
	}

	private async _runTestCommand(
		command: string,
		framework: string,
		timeout: number,
	): Promise<{ summary: TestRunSummary; tests: TestCase[] }> {
		let output: string;
		try {
			output = await this._exec(command, timeout);
		} catch (error) {
			// Test failures result in non-zero exit code, but output is still useful
			if (error && typeof error === 'object' && 'output' in error) {
				output = (error as { output: string }).output;
			} else {
				throw error;
			}
		}

		return this._parseTestOutput(output, framework);
	}

	private _parseTestOutput(output: string, framework: string): { summary: TestRunSummary; tests: TestCase[] } {
		switch (framework) {
			case 'jest':
				return this._parseJestOutput(output);
			case 'vitest':
				return this._parseVitestOutput(output);
			case 'pytest':
				return this._parsePytestOutput(output);
			case 'go test':
				return this._parseGoTestOutput(output);
			case 'cargo test':
				return this._parseCargoTestOutput(output);
			case 'rspec':
				return this._parseRspecOutput(output);
			default:
				return { summary: EMPTY_SUMMARY, tests: [] };
		}
	}

	private _parseJestOutput(output: string): { summary: TestRunSummary; tests: TestCase[] } {
		const tests: TestCase[] = [];
		try {
			// Jest --json outputs a JSON object
			const jsonMatch = output.match(/\{[\s\S]*"testResults"[\s\S]*\}/);
			if (jsonMatch) {
				const json = JSON.parse(jsonMatch[0]);
				let totalDuration = 0;

				for (const suite of json.testResults ?? []) {
					for (const test of suite.assertionResults ?? []) {
						const duration = test.duration ?? 0;
						totalDuration += duration;
						tests.push({
							name: test.fullName ?? test.title ?? '',
							file: suite.name ?? '',
							status: test.status === 'passed' ? 'passed' : test.status === 'pending' ? 'skipped' : 'failed',
							duration,
							errorMessage: test.failureMessages?.join('\n'),
						});
					}
				}

				const passed = tests.filter(t => t.status === 'passed').length;
				const failed = tests.filter(t => t.status === 'failed').length;
				const skipped = tests.filter(t => t.status === 'skipped').length;

				return {
					summary: { total: tests.length, passed, failed, skipped, duration: totalDuration },
					tests,
				};
			}
		} catch {
			// Fall through to empty
		}
		return { summary: EMPTY_SUMMARY, tests };
	}

	private _parseVitestOutput(output: string): { summary: TestRunSummary; tests: TestCase[] } {
		// Vitest JSON reporter outputs similar to Jest
		return this._parseJestOutput(output);
	}

	private _parsePytestOutput(output: string): { summary: TestRunSummary; tests: TestCase[] } {
		const tests: TestCase[] = [];

		// Parse individual test results: PASSED/FAILED/SKIPPED lines
		const testPattern = /^(.+?)::(.+?)\s+(PASSED|FAILED|SKIPPED|ERROR)/gm;
		let match: RegExpExecArray | null;
		while ((match = testPattern.exec(output)) !== null) {
			tests.push({
				name: match[2],
				file: match[1],
				status: match[3] === 'PASSED' ? 'passed' : match[3] === 'SKIPPED' ? 'skipped' : 'failed',
				duration: 0,
			});
		}

		// Parse summary line: "X passed, Y failed, Z skipped"
		const summaryPattern = /(\d+)\s+passed(?:,\s+(\d+)\s+failed)?(?:,\s+(\d+)\s+skipped)?/;
		const summaryMatch = summaryPattern.exec(output);
		const passed = parseInt(summaryMatch?.[1] ?? '0', 10);
		const failed = parseInt(summaryMatch?.[2] ?? '0', 10);
		const skipped = parseInt(summaryMatch?.[3] ?? '0', 10);

		return {
			summary: { total: passed + failed + skipped, passed, failed, skipped, duration: 0 },
			tests,
		};
	}

	private _parseGoTestOutput(output: string): { summary: TestRunSummary; tests: TestCase[] } {
		const tests: TestCase[] = [];

		// Go test -json outputs one JSON line per event
		for (const line of output.split('\n')) {
			if (!line.trim()) {
				continue;
			}
			try {
				const event = JSON.parse(line);
				if (event.Action === 'pass' || event.Action === 'fail' || event.Action === 'skip') {
					if (event.Test) {
						tests.push({
							name: event.Test,
							file: event.Package ?? '',
							status: event.Action === 'pass' ? 'passed' : event.Action === 'skip' ? 'skipped' : 'failed',
							duration: (event.Elapsed ?? 0) * 1000,
						});
					}
				}
			} catch {
				// Not JSON line, skip
			}
		}

		const passed = tests.filter(t => t.status === 'passed').length;
		const failed = tests.filter(t => t.status === 'failed').length;
		const skipped = tests.filter(t => t.status === 'skipped').length;

		return {
			summary: { total: tests.length, passed, failed, skipped, duration: 0 },
			tests,
		};
	}

	private _parseCargoTestOutput(output: string): { summary: TestRunSummary; tests: TestCase[] } {
		const tests: TestCase[] = [];

		// Cargo test output: `test module::test_name ... ok/FAILED`
		const testPattern = /^test\s+(.+?)\s+\.\.\.\s+(ok|FAILED|ignored)/gm;
		let match: RegExpExecArray | null;
		while ((match = testPattern.exec(output)) !== null) {
			tests.push({
				name: match[1],
				file: '',
				status: match[2] === 'ok' ? 'passed' : match[2] === 'ignored' ? 'skipped' : 'failed',
				duration: 0,
			});
		}

		const passed = tests.filter(t => t.status === 'passed').length;
		const failed = tests.filter(t => t.status === 'failed').length;
		const skipped = tests.filter(t => t.status === 'skipped').length;

		return {
			summary: { total: tests.length, passed, failed, skipped, duration: 0 },
			tests,
		};
	}

	private _parseRspecOutput(output: string): { summary: TestRunSummary; tests: TestCase[] } {
		const tests: TestCase[] = [];

		try {
			const json = JSON.parse(output);
			for (const example of json.examples ?? []) {
				tests.push({
					name: example.full_description ?? example.description ?? '',
					file: example.file_path ?? '',
					status: example.status === 'passed' ? 'passed' : example.status === 'pending' ? 'skipped' : 'failed',
					duration: (example.run_time ?? 0) * 1000,
					errorMessage: example.exception?.message,
				});
			}
		} catch {
			// Not JSON
		}

		const passed = tests.filter(t => t.status === 'passed').length;
		const failed = tests.filter(t => t.status === 'failed').length;
		const skipped = tests.filter(t => t.status === 'skipped').length;

		return {
			summary: { total: tests.length, passed, failed, skipped, duration: 0 },
			tests,
		};
	}

	/** Detect regressions: tests that passed in before but fail in after. */
	private _detectRegressions(beforeTests: TestCase[], afterTests: TestCase[]): TestCase[] {
		const beforePassed = new Set(
			beforeTests.filter(t => t.status === 'passed').map(t => `${t.file}::${t.name}`)
		);

		return afterTests.filter(t =>
			t.status === 'failed' && beforePassed.has(`${t.file}::${t.name}`)
		);
	}

	private _skippedResult(reason: string): TestResult {
		this.logService.info(`[Forge] Tests skipped: ${reason}`);
		return {
			status: 'skipped',
			framework: '',
			command: '',
			beforeRun: EMPTY_SUMMARY,
			afterRun: EMPTY_SUMMARY,
			regressions: [],
			relevantTests: [],
			relevantTestCount: 0,
			duration: 0,
		};
	}

	private async _exec(command: string, timeout?: number): Promise<string> {
		const { exec } = await import('child_process');
		return new Promise<string>((resolve, reject) => {
			const folders = this.workspaceContextService.getWorkspace().folders;
			const cwd = folders.length > 0 ? folders[0].uri.fsPath : undefined;

			exec(command, { cwd, timeout: timeout ?? 120000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
				const output = stdout + '\n' + stderr;
				if (error) {
					reject({ code: error.code ?? 1, output });
				} else {
					resolve(output);
				}
			});
		});
	}
}

registerSingleton(IForgeTestRunner, ForgeTestRunner, InstantiationType.Delayed);
