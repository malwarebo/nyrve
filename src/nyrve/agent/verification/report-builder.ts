/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TypeCheckResult } from './type-checker.js';
import { TestResult } from './test-runner.js';
import { CoverageResult } from './coverage-checker.js';
import { ImportCheckResult } from './import-checker.js';
import { VerificationAttempt, VerificationFailure } from './self-healer.js';
import { NyrveChangeSet } from '../../ui/diff-review/diff-panel.js';

// --- Types ---

export interface VerificationSuggestion {
	readonly type: 'write_tests' | 'improve_coverage' | 'add_types' | 'refactor';
	readonly description: string;
	readonly actionLabel: string;
	readonly actionPrompt: string;
}

export interface VerificationReport {
	readonly id: string;
	readonly timestamp: string;
	readonly changeset: NyrveChangeSet;

	// Individual check results
	readonly typeCheck: TypeCheckResult;
	readonly tests: TestResult;
	readonly coverage: CoverageResult;
	readonly imports: ImportCheckResult;

	// Self-healing history
	readonly attempts: VerificationAttempt[];
	readonly totalAttempts: number;

	// Overall status
	readonly status: 'passed' | 'passed_with_warnings' | 'failed';
	readonly confidence: number;
	readonly duration: number;

	// Suggestions
	readonly suggestions: VerificationSuggestion[];
}

// --- Report Builder ---

/**
 * Assembles a VerificationReport from individual check results and attempt history.
 */
export function buildVerificationReport(
	changeset: NyrveChangeSet,
	typeCheck: TypeCheckResult,
	tests: TestResult,
	coverage: CoverageResult,
	imports: ImportCheckResult,
	attempts: VerificationAttempt[],
	duration: number,
): VerificationReport {
	const status = computeStatus(typeCheck, tests, coverage, imports);
	const confidence = computeConfidence(typeCheck, tests, coverage, imports, attempts);
	const suggestions = generateSuggestions(typeCheck, tests, coverage, imports);

	return {
		id: generateReportId(),
		timestamp: new Date().toISOString(),
		changeset,
		typeCheck,
		tests,
		coverage,
		imports,
		attempts,
		totalAttempts: attempts.length,
		status,
		confidence,
		duration,
		suggestions,
	};
}

function computeStatus(
	typeCheck: TypeCheckResult,
	tests: TestResult,
	_coverage: CoverageResult,
	imports: ImportCheckResult,
): 'passed' | 'passed_with_warnings' | 'failed' {
	// Hard failures
	if (typeCheck.status === 'fail' && typeCheck.newErrors.length > 0) {
		return 'failed';
	}
	if (tests.status === 'fail' && tests.regressions.length > 0) {
		return 'failed';
	}
	if (imports.status === 'fail' && imports.brokenImports.some(i => i.reason === 'not_found')) {
		return 'failed';
	}

	// Warnings
	if (_coverage.status === 'warning') {
		return 'passed_with_warnings';
	}
	if (imports.status === 'fail' && imports.newCircularDeps.length > 0) {
		return 'passed_with_warnings';
	}

	return 'passed';
}

/**
 * Calculate confidence score: type check (25%) + tests (35%) + coverage (20%) + imports (10%) + self-heal bonus (10%).
 */
function computeConfidence(
	typeCheck: TypeCheckResult,
	tests: TestResult,
	coverage: CoverageResult,
	imports: ImportCheckResult,
	attempts: VerificationAttempt[],
): number {
	let score = 0;

	// Type check: 25%
	if (typeCheck.status === 'skipped') {
		score += 15; // Partial credit for skipped (can't verify)
	} else if (typeCheck.status === 'pass') {
		score += 25;
	} else if (typeCheck.newErrors.length === 0) {
		score += 25; // All pre-existing
	}

	// Tests: 35%
	if (tests.status === 'skipped' || tests.status === 'no_tests') {
		score += 10; // Minimal credit
	} else if (tests.status === 'pass') {
		score += 35;
	} else {
		// Partial credit based on passing percentage
		const total = tests.afterRun.total;
		const passed = tests.afterRun.passed;
		if (total > 0) {
			score += Math.round(35 * (passed / total));
		}
	}

	// Coverage: 20%
	if (coverage.status === 'skipped') {
		score += 10;
	} else if (coverage.status === 'pass') {
		score += 20;
	} else {
		// Partial credit based on coverage percentage
		score += Math.round(20 * (coverage.overallCoveragePercent / 100));
	}

	// Imports: 10%
	if (imports.status === 'skipped') {
		score += 5;
	} else if (imports.status === 'pass') {
		score += 10;
	}

	// Self-heal bonus: 10% — get full bonus if no healing needed, partial if healed
	if (attempts.length === 0) {
		score += 10; // No healing needed = best outcome
	} else {
		const lastAttempt = attempts[attempts.length - 1];
		if (lastAttempt.result === 'fixed') {
			score += 7; // Successfully self-healed
		} else if (lastAttempt.result === 'partially_fixed') {
			score += 3;
		}
	}

	return Math.min(100, Math.max(0, score));
}

function generateSuggestions(
	typeCheck: TypeCheckResult,
	tests: TestResult,
	coverage: CoverageResult,
	imports: ImportCheckResult,
): VerificationSuggestion[] {
	const suggestions: VerificationSuggestion[] = [];

	// Suggest writing tests if no relevant tests
	if (tests.status === 'no_tests' || tests.relevantTestCount === 0) {
		suggestions.push({
			type: 'write_tests',
			description: "No tests found for the modified files. Adding tests would improve confidence.",
			actionLabel: "Write Tests",
			actionPrompt: "Write unit tests for the files I just modified. Cover the key behaviors and edge cases.",
		});
	}

	// Suggest improving coverage
	if (coverage.status === 'warning' && coverage.fileCoverage.length > 0) {
		const uncoveredFiles = coverage.fileCoverage
			.filter(f => f.uncoveredLines.length > 0)
			.map(f => `${f.file} (lines ${f.uncoveredLines.slice(0, 5).join(', ')}${f.uncoveredLines.length > 5 ? '...' : ''})`)
			.join(', ');

		suggestions.push({
			type: 'improve_coverage',
			description: `${coverage.totalChangedLines - coverage.totalCoveredLines} changed lines lack test coverage in: ${uncoveredFiles}`,
			actionLabel: "Improve Coverage",
			actionPrompt: `Write additional tests to cover the uncovered changed lines. Focus on: ${uncoveredFiles}`,
		});
	}

	// Suggest adding types
	if (typeCheck.status === 'fail' && typeCheck.newErrors.length > 0) {
		suggestions.push({
			type: 'add_types',
			description: `${typeCheck.newErrors.length} new type error(s) introduced. Fix the type issues.`,
			actionLabel: "Fix Types",
			actionPrompt: `Fix these type errors:\n${typeCheck.newErrors.map(e => `- ${e.file}:${e.line}: ${e.message}`).join('\n')}`,
		});
	}

	// Suggest fixing imports
	if (imports.status === 'fail' && imports.brokenImports.length > 0) {
		suggestions.push({
			type: 'refactor',
			description: `${imports.brokenImports.length} broken import(s) detected.`,
			actionLabel: "Fix Imports",
			actionPrompt: `Fix these broken imports:\n${imports.brokenImports.map(i => `- ${i.file}:${i.line}: ${i.importPath} (${i.reason})`).join('\n')}`,
		});
	}

	return suggestions;
}

function generateReportId(): string {
	return `vr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Collect all failures from verification results into a flat list.
 */
export function collectFailures(
	typeCheck: TypeCheckResult,
	tests: TestResult,
	imports: ImportCheckResult,
): VerificationFailure[] {
	const failures: VerificationFailure[] = [];

	// Type errors
	for (const err of typeCheck.newErrors) {
		failures.push({
			type: 'type_error',
			severity: err.severity,
			file: err.file,
			line: err.line,
			message: `${err.code}: ${err.message}`,
			details: `Type error at ${err.file}:${err.line}:${err.column} — ${err.message}`,
		});
	}

	// Test regressions
	for (const reg of tests.regressions) {
		failures.push({
			type: 'test_failure',
			severity: 'error',
			file: reg.file,
			message: `Test regression: ${reg.name}`,
			details: reg.errorMessage ?? `Test "${reg.name}" passed before but fails after agent changes`,
		});
	}

	// Broken imports
	for (const imp of imports.brokenImports) {
		failures.push({
			type: 'import_error',
			severity: imp.reason === 'not_found' ? 'error' : 'warning',
			file: imp.file,
			line: imp.line,
			message: `Broken import: ${imp.importPath} (${imp.reason})`,
			details: imp.suggestion ?? `Import "${imp.importPath}" could not be resolved`,
		});
	}

	return failures;
}
