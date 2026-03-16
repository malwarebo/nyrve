/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../vs/nls.js';
import { VerificationReport } from '../../agent/verification/report-builder.js';

/**
 * Renders inline verification badges for use in task queue, status bar, etc.
 */
export function renderConfidenceBadge(confidence: number): string {
	const color = confidence >= 80 ? 'green' : confidence >= 60 ? 'yellow' : 'red';
	return `<span class="nyrve-confidence-badge nyrve-confidence-${color}">${confidence}%</span>`;
}

/**
 * Renders the verification status as a compact inline indicator.
 */
export function renderVerificationStatus(report: VerificationReport | undefined, isVerifying: boolean): string {
	if (isVerifying) {
		return `<span class="nyrve-vr-status nyrve-vr-verifying">⏳ ${localize('nyrve.verification.verifying', "Verifying...")}</span>`;
	}

	if (!report) {
		return '';
	}

	switch (report.status) {
		case 'passed':
			return `<span class="nyrve-vr-status nyrve-vr-passed">✅ ${localize('nyrve.verification.verified', "Verified")} ${renderConfidenceBadge(report.confidence)}</span>`;
		case 'passed_with_warnings':
			return `<span class="nyrve-vr-status nyrve-vr-warnings">⚠️ ${localize('nyrve.verification.verifiedWarnings', "Verified with warnings")} ${renderConfidenceBadge(report.confidence)}</span>`;
		case 'failed':
			return `<span class="nyrve-vr-status nyrve-vr-failed">❌ ${localize('nyrve.verification.failed', "Verification failed")}</span>`;
		default:
			return '';
	}
}

/**
 * Generate the Nyrve-Verified footer for commit messages.
 */
export function generateCommitFooter(report: VerificationReport): string {
	const lines: string[] = [];

	lines.push(`Nyrve-Verified: ${report.status === 'passed' ? 'pass' : report.status === 'passed_with_warnings' ? 'pass_with_warnings' : 'fail'}`);
	lines.push(`Nyrve-Confidence: ${report.confidence}%`);

	if (report.tests.status !== 'skipped') {
		lines.push(`Nyrve-Tests: ${report.tests.afterRun.passed} passed, ${report.tests.afterRun.failed} failed`);
	}

	if (report.coverage.status !== 'skipped') {
		lines.push(`Nyrve-Coverage: ${report.coverage.overallCoveragePercent}% of changed lines`);
	}

	return lines.join('\n');
}
