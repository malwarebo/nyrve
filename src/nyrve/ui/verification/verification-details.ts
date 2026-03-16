/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../vs/nls.js';
import { TypeCheckResult, TypeDiagnostic } from '../../agent/verification/type-checker.js';
import { TestResult, TestCase } from '../../agent/verification/test-runner.js';
import { CoverageResult, FileCoverageInfo } from '../../agent/verification/coverage-checker.js';
import { ImportCheckResult } from '../../agent/verification/import-checker.js';
import { VerificationAttempt } from '../../agent/verification/self-healer.js';

/**
 * Renders expandable detail sections for each verification check.
 */
export function renderTypeCheckDetails(result: TypeCheckResult): string {
	if (result.status === 'skipped') {
		return `<div class="nyrve-vr-detail-empty">${localize('nyrve.verification.typeCheckSkipped', "Type checking was skipped (no type checker detected)")}</div>`;
	}

	const parts: string[] = [];
	parts.push(`<div class="nyrve-vr-detail">`);
	parts.push(`<div class="nyrve-vr-detail-header">${localize('nyrve.verification.typeCheckDetail', "Type Check Details ({0})", result.checkerUsed)}</div>`);

	if (result.newErrors.length > 0) {
		parts.push(`<div class="nyrve-vr-detail-section">`);
		parts.push(`<strong>${localize('nyrve.verification.newErrors', "New Errors ({0})", result.newErrors.length)}</strong>`);
		for (const err of result.newErrors) {
			parts.push(renderDiagnosticRow(err));
		}
		parts.push(`</div>`);
	}

	if (result.fixedErrors.length > 0) {
		parts.push(`<div class="nyrve-vr-detail-section">`);
		parts.push(`<strong>${localize('nyrve.verification.fixedErrors', "Fixed Errors ({0})", result.fixedErrors.length)}</strong>`);
		for (const err of result.fixedErrors) {
			parts.push(renderDiagnosticRow(err));
		}
		parts.push(`</div>`);
	}

	parts.push(`<div class="nyrve-vr-detail-meta">${localize('nyrve.verification.duration', "Duration: {0}s", Math.round(result.duration / 1000))}</div>`);
	parts.push(`</div>`);
	return parts.join('\n');
}

export function renderTestDetails(result: TestResult): string {
	if (result.status === 'skipped' || result.status === 'no_tests') {
		return `<div class="nyrve-vr-detail-empty">${localize('nyrve.verification.testsSkipped', "Test running was skipped")}</div>`;
	}

	const parts: string[] = [];
	parts.push(`<div class="nyrve-vr-detail">`);
	parts.push(`<div class="nyrve-vr-detail-header">${localize('nyrve.verification.testDetail', "Test Details ({0})", result.framework)}</div>`);
	parts.push(`<div class="nyrve-vr-detail-command"><code>${result.command}</code></div>`);

	// Regressions
	if (result.regressions.length > 0) {
		parts.push(`<div class="nyrve-vr-detail-section nyrve-vr-regressions">`);
		parts.push(`<strong>\u274C ${localize('nyrve.verification.regressions', "Regressions ({0})", result.regressions.length)}</strong>`);
		for (const test of result.regressions) {
			parts.push(renderTestCaseRow(test));
		}
		parts.push(`</div>`);
	}

	// Summary comparison
	parts.push(`<div class="nyrve-vr-detail-section">`);
	parts.push(`<table class="nyrve-vr-test-comparison">`);
	parts.push(`<tr><th></th><th>${localize('nyrve.verification.before', "Before")}</th><th>${localize('nyrve.verification.after', "After")}</th></tr>`);
	parts.push(`<tr><td>${localize('nyrve.verification.passed', "Passed")}</td><td>${result.beforeRun.passed}</td><td>${result.afterRun.passed}</td></tr>`);
	parts.push(`<tr><td>${localize('nyrve.verification.failed', "Failed")}</td><td>${result.beforeRun.failed}</td><td>${result.afterRun.failed}</td></tr>`);
	parts.push(`<tr><td>${localize('nyrve.verification.testSkipped', "Skipped")}</td><td>${result.beforeRun.skipped}</td><td>${result.afterRun.skipped}</td></tr>`);
	parts.push(`</table>`);
	parts.push(`</div>`);

	parts.push(`</div>`);
	return parts.join('\n');
}

export function renderCoverageDetails(result: CoverageResult): string {
	if (result.status === 'skipped') {
		return `<div class="nyrve-vr-detail-empty">${localize('nyrve.verification.coverageSkipped', "Coverage checking was skipped")}</div>`;
	}

	const parts: string[] = [];
	parts.push(`<div class="nyrve-vr-detail">`);
	parts.push(`<div class="nyrve-vr-detail-header">${localize('nyrve.verification.coverageDetail', "Coverage Details")}</div>`);
	parts.push(`<div class="nyrve-vr-detail-section">`);
	parts.push(`<strong>${localize('nyrve.verification.overallCoverage', "Overall: {0}% ({1}/{2} changed lines covered)",
		result.overallCoveragePercent, result.totalCoveredLines, result.totalChangedLines)}</strong>`);
	parts.push(`</div>`);

	if (result.fileCoverage.length > 0) {
		parts.push(`<div class="nyrve-vr-detail-section">`);
		for (const fc of result.fileCoverage) {
			parts.push(renderFileCoverageRow(fc));
		}
		parts.push(`</div>`);
	}

	parts.push(`</div>`);
	return parts.join('\n');
}

export function renderImportDetails(result: ImportCheckResult): string {
	if (result.status === 'skipped') {
		return `<div class="nyrve-vr-detail-empty">${localize('nyrve.verification.importsSkipped', "Import checking was skipped")}</div>`;
	}

	const parts: string[] = [];
	parts.push(`<div class="nyrve-vr-detail">`);
	parts.push(`<div class="nyrve-vr-detail-header">${localize('nyrve.verification.importDetail', "Import Details")}</div>`);

	if (result.brokenImports.length > 0) {
		parts.push(`<div class="nyrve-vr-detail-section">`);
		for (const imp of result.brokenImports) {
			parts.push(`<div class="nyrve-vr-broken-import">`);
			parts.push(`<span class="nyrve-vr-file">${imp.file}:${imp.line}</span> `);
			parts.push(`<code>${imp.importPath}</code> — ${imp.reason}`);
			if (imp.suggestion) {
				parts.push(` <em>${imp.suggestion}</em>`);
			}
			parts.push(`</div>`);
		}
		parts.push(`</div>`);
	}

	if (result.newCircularDeps.length > 0) {
		parts.push(`<div class="nyrve-vr-detail-section">`);
		parts.push(`<strong>${localize('nyrve.verification.circularDeps', "Circular Dependencies")}</strong>`);
		for (const dep of result.newCircularDeps) {
			parts.push(`<div class="nyrve-vr-cycle">${dep.cycle.join(' → ')}</div>`);
		}
		parts.push(`</div>`);
	}

	parts.push(`</div>`);
	return parts.join('\n');
}

export function renderSelfHealHistory(attempts: VerificationAttempt[]): string {
	if (attempts.length === 0) {
		return '';
	}

	const parts: string[] = [];
	parts.push(`<div class="nyrve-vr-heal-history">`);
	parts.push(`<div class="nyrve-vr-detail-header">${localize('nyrve.verification.healHistory', "Self-Heal History")}</div>`);

	for (const attempt of attempts) {
		const resultIcon = attempt.result === 'fixed' ? '\u2705' : attempt.result === 'partially_fixed' ? '⚠️' : '\u274C';
		parts.push(`<div class="nyrve-vr-heal-attempt">`);
		parts.push(`<strong>${resultIcon} ${localize('nyrve.verification.attempt', "Attempt {0}", attempt.attemptNumber)}</strong>`);

		if (attempt.failures.length > 0) {
			parts.push(`<div class="nyrve-vr-heal-failures">`);
			for (const failure of attempt.failures) {
				parts.push(`<div>\u274C ${failure.type}: ${failure.message}</div>`);
			}
			parts.push(`</div>`);
		}

		if (attempt.fixesApplied.length > 0) {
			parts.push(`<div class="nyrve-vr-heal-fixes">`);
			for (const fix of attempt.fixesApplied) {
				parts.push(`<div>\u{1F527} ${fix.fixDescription}</div>`);
			}
			parts.push(`</div>`);
		}

		parts.push(`</div>`);
	}

	parts.push(`</div>`);
	return parts.join('\n');
}

// --- Row renderers ---

function renderDiagnosticRow(diag: TypeDiagnostic): string {
	return `<div class="nyrve-vr-diagnostic">` +
		`<span class="nyrve-vr-file">${diag.file}:${diag.line}:${diag.column}</span> ` +
		`<span class="nyrve-vr-code">${diag.code}</span> ` +
		`<span class="nyrve-vr-message">${diag.message}</span>` +
		`</div>`;
}

function renderTestCaseRow(test: TestCase): string {
	const statusIcon = test.status === 'passed' ? '\u2705' : test.status === 'failed' ? '\u274C' : '\u23ED';
	return `<div class="nyrve-vr-test-case">` +
		`${statusIcon} <span class="nyrve-vr-test-name">${test.name}</span>` +
		(test.errorMessage ? `<div class="nyrve-vr-test-error">${test.errorMessage}</div>` : '') +
		`</div>`;
}

function renderFileCoverageRow(fc: FileCoverageInfo): string {
	const color = fc.coveragePercent >= 80 ? 'green' : fc.coveragePercent >= 50 ? 'yellow' : 'red';
	return `<div class="nyrve-vr-file-coverage">` +
		`<span class="nyrve-vr-file">${fc.file}</span> ` +
		`<span class="nyrve-vr-coverage-pct nyrve-coverage-${color}">${fc.coveragePercent}%</span> ` +
		`<span>(${fc.coveredLines.length}/${fc.changedLines.length} lines)</span>` +
		(fc.uncoveredLines.length > 0
			? ` <span class="nyrve-vr-uncovered">${localize('nyrve.verification.uncovered', "uncovered: lines {0}", fc.uncoveredLines.slice(0, 10).join(', '))}</span>`
			: '') +
		`</div>`;
}
