/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../vs/base/common/event.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import { ForgeChangeSet } from '../ui/diff-review/diff-panel.js';
import { IForgeTypeChecker, TypeCheckResult } from './verification/type-checker.js';
import { IForgeTestRunner, TestResult } from './verification/test-runner.js';
import { IForgeCoverageChecker, CoverageResult } from './verification/coverage-checker.js';
import { IForgeImportChecker, ImportCheckResult } from './verification/import-checker.js';
import { IForgeSelfHealer, VerificationAttempt } from './verification/self-healer.js';
import { IForgeFrameworkDetector, TestRunnerConfig, TypeCheckerConfig } from './verification/framework-detector.js';
import {
	VerificationReport,
	buildVerificationReport,
	collectFailures,
} from './verification/report-builder.js';

// --- Types ---

export type VerificationStep = 'type_check' | 'tests' | 'coverage' | 'imports' | 'self_heal';

export interface VerificationProgress {
	readonly step: VerificationStep;
	readonly status: 'running' | 'passed' | 'failed' | 'skipped';
	readonly message: string;
}

// --- Service Interface ---

export const IForgeVerificationEngine = createDecorator<IForgeVerificationEngine>('forgeVerificationEngine');

export interface IForgeVerificationEngine {
	readonly _serviceBrand: undefined;

	/** Fires on each verification step for progress updates. */
	readonly onDidProgress: Event<VerificationProgress>;

	/** Run full verification pipeline on a changeset. */
	verify(changeset: ForgeChangeSet): Promise<VerificationReport>;

	/** Run individual checks. */
	runTypeCheck(changeset: ForgeChangeSet): Promise<TypeCheckResult>;
	runTests(changeset: ForgeChangeSet): Promise<TestResult>;
	runCoverageCheck(changeset: ForgeChangeSet): Promise<CoverageResult>;
	runImportCheck(changeset: ForgeChangeSet): Promise<ImportCheckResult>;

	/** Get project test/type configuration. */
	getProjectTestConfig(): Promise<TestRunnerConfig>;
	getProjectTypeConfig(): Promise<TypeCheckerConfig>;
}

// --- Service Implementation ---

export class ForgeVerificationEngine extends Disposable implements IForgeVerificationEngine {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidProgress = this._register(new Emitter<VerificationProgress>());
	readonly onDidProgress: Event<VerificationProgress> = this._onDidProgress.event;

	constructor(
		@IForgeTypeChecker private readonly typeChecker: IForgeTypeChecker,
		@IForgeTestRunner private readonly testRunner: IForgeTestRunner,
		@IForgeCoverageChecker private readonly coverageChecker: IForgeCoverageChecker,
		@IForgeImportChecker private readonly importChecker: IForgeImportChecker,
		@IForgeSelfHealer private readonly selfHealer: IForgeSelfHealer,
		@IForgeFrameworkDetector private readonly frameworkDetector: IForgeFrameworkDetector,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async verify(changeset: ForgeChangeSet): Promise<VerificationReport> {
		const enabled = this.configurationService.getValue<boolean>('forge.verification.enabled') ?? true;
		if (!enabled) {
			return this._buildSkippedReport(changeset);
		}

		const startTime = Date.now();
		const maxAttempts = this.configurationService.getValue<number>('forge.verification.maxSelfHealAttempts') ?? 3;
		const attempts: VerificationAttempt[] = [];

		let currentChangeset = changeset;
		let attempt = 0;

		while (attempt <= maxAttempts) {
			this.logService.info(`[Forge] Verification pipeline${attempt > 0 ? ` (after heal attempt ${attempt})` : ''}`);

			// Step 1: Type check
			this._fireProgress('type_check', 'running', "Running type check...");
			const typeCheck = await this.typeChecker.check(currentChangeset);
			this._fireProgress('type_check', typeCheck.status === 'fail' ? 'failed' : typeCheck.status === 'skipped' ? 'skipped' : 'passed',
				typeCheck.status === 'fail' ? `${typeCheck.newErrors.length} new type errors` : "Type check passed");

			// Step 2: Tests
			this._fireProgress('tests', 'running', "Running tests...");
			const tests = await this.testRunner.runTests(currentChangeset);
			this._fireProgress('tests', tests.status === 'fail' ? 'failed' : tests.status === 'skipped' ? 'skipped' : 'passed',
				tests.status === 'fail' ? `${tests.regressions.length} regressions` : `${tests.afterRun.passed} tests passed`);

			// Step 3: Coverage
			this._fireProgress('coverage', 'running', "Checking coverage...");
			const coverage = await this.coverageChecker.checkCoverage(currentChangeset);
			this._fireProgress('coverage', coverage.status === 'warning' ? 'failed' : coverage.status === 'skipped' ? 'skipped' : 'passed',
				coverage.status === 'skipped' ? "Coverage skipped" : `${coverage.overallCoveragePercent}% coverage`);

			// Step 4: Import check
			this._fireProgress('imports', 'running', "Checking imports...");
			const imports = await this.importChecker.checkImports(currentChangeset);
			this._fireProgress('imports', imports.status === 'fail' ? 'failed' : imports.status === 'skipped' ? 'skipped' : 'passed',
				imports.status === 'fail' ? `${imports.brokenImports.length} broken imports` : "All imports resolved");

			// Collect failures
			const failures = collectFailures(typeCheck, tests, imports);

			// If no error-level failures, we're done
			const errorFailures = failures.filter(f => f.severity === 'error');
			if (errorFailures.length === 0) {
				const duration = Date.now() - startTime;
				return buildVerificationReport(currentChangeset, typeCheck, tests, coverage, imports, attempts, duration);
			}

			// Step 5: Self-heal if we haven't exhausted attempts
			attempt++;
			if (attempt > maxAttempts) {
				// No more attempts — return with failures
				const duration = Date.now() - startTime;
				return buildVerificationReport(currentChangeset, typeCheck, tests, coverage, imports, attempts, duration);
			}

			this._fireProgress('self_heal', 'running', `Self-healing attempt ${attempt}/${maxAttempts}...`);
			const healResult = await this.selfHealer.heal(currentChangeset, errorFailures, attempt);

			attempts.push({
				attemptNumber: attempt,
				failures: errorFailures,
				fixesApplied: healResult.fixesApplied,
				result: healResult.status === 'healed' ? 'fixed'
					: healResult.status === 'partially_healed' ? 'partially_fixed'
						: 'could_not_fix',
			});

			this._fireProgress('self_heal',
				healResult.status === 'healed' ? 'passed' : healResult.status === 'could_not_heal' ? 'failed' : 'running',
				healResult.status === 'healed' ? "All issues fixed"
					: `${healResult.fixesApplied.length} fix(es) applied, ${healResult.remainingFailures.length} remaining`);

			if (healResult.status === 'could_not_heal') {
				// Self-healer gave up — return current state
				const duration = Date.now() - startTime;
				const typeCheckFinal = await this.typeChecker.check(currentChangeset);
				const testsFinal = await this.testRunner.runTests(currentChangeset);
				return buildVerificationReport(currentChangeset, typeCheckFinal, testsFinal, coverage, imports, attempts, duration);
			}

			currentChangeset = healResult.updatedChangeset;
			// Loop back to re-verify
		}

		// Should not reach here, but just in case
		const duration = Date.now() - startTime;
		const typeCheck = await this.typeChecker.check(currentChangeset);
		const tests = await this.testRunner.runTests(currentChangeset);
		const coverage = await this.coverageChecker.checkCoverage(currentChangeset);
		const imports = await this.importChecker.checkImports(currentChangeset);
		return buildVerificationReport(currentChangeset, typeCheck, tests, coverage, imports, attempts, duration);
	}

	async runTypeCheck(changeset: ForgeChangeSet): Promise<TypeCheckResult> {
		return this.typeChecker.check(changeset);
	}

	async runTests(changeset: ForgeChangeSet): Promise<TestResult> {
		return this.testRunner.runTests(changeset);
	}

	async runCoverageCheck(changeset: ForgeChangeSet): Promise<CoverageResult> {
		return this.coverageChecker.checkCoverage(changeset);
	}

	async runImportCheck(changeset: ForgeChangeSet): Promise<ImportCheckResult> {
		return this.importChecker.checkImports(changeset);
	}

	async getProjectTestConfig(): Promise<TestRunnerConfig> {
		const result = await this.frameworkDetector.getDetectionResult();
		return result.testRunner;
	}

	async getProjectTypeConfig(): Promise<TypeCheckerConfig> {
		const result = await this.frameworkDetector.getDetectionResult();
		return result.typeChecker;
	}

	private _buildSkippedReport(changeset: ForgeChangeSet): VerificationReport {
		return buildVerificationReport(
			changeset,
			{ status: 'skipped', errorsBefore: [], errorsAfter: [], newErrors: [], fixedErrors: [], checkerUsed: '', duration: 0 },
			{ status: 'skipped', framework: '', command: '', beforeRun: { total: 0, passed: 0, failed: 0, skipped: 0, duration: 0 }, afterRun: { total: 0, passed: 0, failed: 0, skipped: 0, duration: 0 }, regressions: [], relevantTests: [], relevantTestCount: 0, duration: 0 },
			{ status: 'skipped', fileCoverage: [], totalChangedLines: 0, totalCoveredLines: 0, overallCoveragePercent: 0, coverageThreshold: 70, meetsThreshold: false },
			{ status: 'skipped', brokenImports: [], newCircularDeps: [] },
			[],
			0,
		);
	}

	private _fireProgress(step: VerificationStep, status: 'running' | 'passed' | 'failed' | 'skipped', message: string): void {
		this._onDidProgress.fire({ step, status, message });
	}
}

registerSingleton(IForgeVerificationEngine, ForgeVerificationEngine, InstantiationType.Delayed);
