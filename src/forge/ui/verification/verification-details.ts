/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
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
		return `<div class="forge-vr-detail-empty">${localize('forge.verification.typeCheckSkipped', "Type checking was skipped (no type checker detected)")}</div>`;
	}

	const parts: string[] = [];
	parts.push(`<div class="forge-vr-detail">`);
	parts.push(`<div class="forge-vr-detail-header">${localize('forge.verification.typeCheckDetail', "Type Check Details ({0})", result.checkerUsed)}</div>`);

	if (result.newErrors.length > 0) {
		parts.push(`<div class="forge-vr-detail-section">`);
		parts.push(`<strong>${localize('forge.verification.newErrors', "New Errors ({0})", result.newErrors.length)}</strong>`);
		for (const err of result.newErrors) {
			parts.push(renderDiagnosticRow(err));
		}
		parts.push(`</div>`);
	}

	if (result.fixedErrors.length > 0) {
		parts.push(`<div class="forge-vr-detail-section">`);
		parts.push(`<strong>${localize('forge.verification.fixedErrors', "Fixed Errors ({0})", result.fixedErrors.length)}</strong>`);
		for (const err of result.fixedErrors) {
			parts.push(renderDiagnosticRow(err));
		}
		parts.push(`</div>`);
	}

	parts.push(`<div class="forge-vr-detail-meta">${localize('forge.verification.duration', "Duration: {0}s", Math.round(result.duration / 1000))}</div>`);
	parts.push(`</div>`);
	return parts.join('\n');
}

export function renderTestDetails(result: TestResult): string {
	if (result.status === 'skipped' || result.status === 'no_tests') {
		return `<div class="forge-vr-detail-empty">${localize('forge.verification.testsSkipped', "Test running was skipped")}</div>`;
	}

	const parts: string[] = [];
	parts.push(`<div class="forge-vr-detail">`);
	parts.push(`<div class="forge-vr-detail-header">${localize('forge.verification.testDetail', "Test Details ({0})", result.framework)}</div>`);
	parts.push(`<div class="forge-vr-detail-command"><code>${result.command}</code></div>`);

	// Regressions
	if (result.regressions.length > 0) {
		parts.push(`<div class="forge-vr-detail-section forge-vr-regressions">`);
		parts.push(`<strong>❌ ${localize('forge.verification.regressions', "Regressions ({0})", result.regressions.length)}</strong>`);
		for (const test of result.regressions) {
			parts.push(renderTestCaseRow(test));
		}
		parts.push(`</div>`);
	}

	// Summary comparison
	parts.push(`<div class="forge-vr-detail-section">`);
	parts.push(`<table class="forge-vr-test-comparison">`);
	parts.push(`<tr><th></th><th>${localize('forge.verification.before', "Before")}</th><th>${localize('forge.verification.after', "After")}</th></tr>`);
	parts.push(`<tr><td>${localize('forge.verification.passed', "Passed")}</td><td>${result.beforeRun.passed}</td><td>${result.afterRun.passed}</td></tr>`);
	parts.push(`<tr><td>${localize('forge.verification.failed', "Failed")}</td><td>${result.beforeRun.failed}</td><td>${result.afterRun.failed}</td></tr>`);
	parts.push(`<tr><td>${localize('forge.verification.testSkipped', "Skipped")}</td><td>${result.beforeRun.skipped}</td><td>${result.afterRun.skipped}</td></tr>`);
	parts.push(`</table>`);
	parts.push(`</div>`);

	parts.push(`</div>`);
	return parts.join('\n');
}

export function renderCoverageDetails(result: CoverageResult): string {
	if (result.status === 'skipped') {
		return `<div class="forge-vr-detail-empty">${localize('forge.verification.coverageSkipped', "Coverage checking was skipped")}</div>`;
	}

	const parts: string[] = [];
	parts.push(`<div class="forge-vr-detail">`);
	parts.push(`<div class="forge-vr-detail-header">${localize('forge.verification.coverageDetail', "Coverage Details")}</div>`);
	parts.push(`<div class="forge-vr-detail-section">`);
	parts.push(`<strong>${localize('forge.verification.overallCoverage', "Overall: {0}% ({1}/{2} changed lines covered)",
		result.overallCoveragePercent, result.totalCoveredLines, result.totalChangedLines)}</strong>`);
	parts.push(`</div>`);

	if (result.fileCoverage.length > 0) {
		parts.push(`<div class="forge-vr-detail-section">`);
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
		return `<div class="forge-vr-detail-empty">${localize('forge.verification.importsSkipped', "Import checking was skipped")}</div>`;
	}

	const parts: string[] = [];
	parts.push(`<div class="forge-vr-detail">`);
	parts.push(`<div class="forge-vr-detail-header">${localize('forge.verification.importDetail', "Import Details")}</div>`);

	if (result.brokenImports.length > 0) {
		parts.push(`<div class="forge-vr-detail-section">`);
		for (const imp of result.brokenImports) {
			parts.push(`<div class="forge-vr-broken-import">`);
			parts.push(`<span class="forge-vr-file">${imp.file}:${imp.line}</span> `);
			parts.push(`<code>${imp.importPath}</code> — ${imp.reason}`);
			if (imp.suggestion) {
				parts.push(` <em>${imp.suggestion}</em>`);
			}
			parts.push(`</div>`);
		}
		parts.push(`</div>`);
	}

	if (result.newCircularDeps.length > 0) {
		parts.push(`<div class="forge-vr-detail-section">`);
		parts.push(`<strong>${localize('forge.verification.circularDeps', "Circular Dependencies")}</strong>`);
		for (const dep of result.newCircularDeps) {
			parts.push(`<div class="forge-vr-cycle">${dep.cycle.join(' → ')}</div>`);
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
	parts.push(`<div class="forge-vr-heal-history">`);
	parts.push(`<div class="forge-vr-detail-header">${localize('forge.verification.healHistory', "Self-Heal History")}</div>`);

	for (const attempt of attempts) {
		const resultIcon = attempt.result === 'fixed' ? '✅' : attempt.result === 'partially_fixed' ? '⚠️' : '❌';
		parts.push(`<div class="forge-vr-heal-attempt">`);
		parts.push(`<strong>${resultIcon} ${localize('forge.verification.attempt', "Attempt {0}", attempt.attemptNumber)}</strong>`);

		if (attempt.failures.length > 0) {
			parts.push(`<div class="forge-vr-heal-failures">`);
			for (const failure of attempt.failures) {
				parts.push(`<div>❌ ${failure.type}: ${failure.message}</div>`);
			}
			parts.push(`</div>`);
		}

		if (attempt.fixesApplied.length > 0) {
			parts.push(`<div class="forge-vr-heal-fixes">`);
			for (const fix of attempt.fixesApplied) {
				parts.push(`<div>🔧 ${fix.fixDescription}</div>`);
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
	return `<div class="forge-vr-diagnostic">` +
		`<span class="forge-vr-file">${diag.file}:${diag.line}:${diag.column}</span> ` +
		`<span class="forge-vr-code">${diag.code}</span> ` +
		`<span class="forge-vr-message">${diag.message}</span>` +
		`</div>`;
}

function renderTestCaseRow(test: TestCase): string {
	const statusIcon = test.status === 'passed' ? '✅' : test.status === 'failed' ? '❌' : '⏭';
	return `<div class="forge-vr-test-case">` +
		`${statusIcon} <span class="forge-vr-test-name">${test.name}</span>` +
		(test.errorMessage ? `<div class="forge-vr-test-error">${test.errorMessage}</div>` : '') +
		`</div>`;
}

function renderFileCoverageRow(fc: FileCoverageInfo): string {
	const color = fc.coveragePercent >= 80 ? 'green' : fc.coveragePercent >= 50 ? 'yellow' : 'red';
	return `<div class="forge-vr-file-coverage">` +
		`<span class="forge-vr-file">${fc.file}</span> ` +
		`<span class="forge-vr-coverage-pct forge-coverage-${color}">${fc.coveragePercent}%</span> ` +
		`<span>(${fc.coveredLines.length}/${fc.changedLines.length} lines)</span>` +
		(fc.uncoveredLines.length > 0
			? ` <span class="forge-vr-uncovered">${localize('forge.verification.uncovered', "uncovered: lines {0}", fc.uncoveredLines.slice(0, 10).join(', '))}</span>`
			: '') +
		`</div>`;
}
