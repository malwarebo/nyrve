/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../vs/nls.js';
import { VerificationReport } from '../../agent/verification/report-builder.js';

/**
 * Renders inline verification badges for use in task queue, status bar, etc.
 */
export function renderConfidenceBadge(confidence: number): string {
	const color = confidence >= 80 ? 'green' : confidence >= 60 ? 'yellow' : 'red';
	return `<span class="forge-confidence-badge forge-confidence-${color}">${confidence}%</span>`;
}

/**
 * Renders the verification status as a compact inline indicator.
 */
export function renderVerificationStatus(report: VerificationReport | undefined, isVerifying: boolean): string {
	if (isVerifying) {
		return `<span class="forge-vr-status forge-vr-verifying">⏳ ${localize('forge.verification.verifying', "Verifying...")}</span>`;
	}

	if (!report) {
		return '';
	}

	switch (report.status) {
		case 'passed':
			return `<span class="forge-vr-status forge-vr-passed">✅ ${localize('forge.verification.verified', "Verified")} ${renderConfidenceBadge(report.confidence)}</span>`;
		case 'passed_with_warnings':
			return `<span class="forge-vr-status forge-vr-warnings">⚠️ ${localize('forge.verification.verifiedWarnings', "Verified with warnings")} ${renderConfidenceBadge(report.confidence)}</span>`;
		case 'failed':
			return `<span class="forge-vr-status forge-vr-failed">❌ ${localize('forge.verification.failed', "Verification failed")}</span>`;
		default:
			return '';
	}
}

/**
 * Generate the Forge-Verified footer for commit messages.
 */
export function generateCommitFooter(report: VerificationReport): string {
	const lines: string[] = [];

	lines.push(`Forge-Verified: ${report.status === 'passed' ? 'pass' : report.status === 'passed_with_warnings' ? 'pass_with_warnings' : 'fail'}`);
	lines.push(`Forge-Confidence: ${report.confidence}%`);

	if (report.tests.status !== 'skipped') {
		lines.push(`Forge-Tests: ${report.tests.afterRun.passed} passed, ${report.tests.afterRun.failed} failed`);
	}

	if (report.coverage.status !== 'skipped') {
		lines.push(`Forge-Coverage: ${report.coverage.overallCoveragePercent}% of changed lines`);
	}

	return lines.join('\n');
}
