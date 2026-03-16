/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../vs/nls.js';
import { Disposable, DisposableStore } from '../../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../../vs/platform/log/common/log.js';
import { INyrveAgentService } from '../../agent/agent-service.js';
import { VerificationReport, VerificationSuggestion } from '../../agent/verification/report-builder.js';
import { VerificationProgress } from '../../agent/verification-engine.js';

// --- Types ---

export interface VerificationPanelState {
	readonly report: VerificationReport | undefined;
	readonly isVerifying: boolean;
	readonly currentStep: string;
	readonly expanded: Set<string>;
}

// --- Service Interface ---

export const INyrveVerificationPanel = createDecorator<INyrveVerificationPanel>('nyrveVerificationPanel');

export interface INyrveVerificationPanel {
	readonly _serviceBrand: undefined;

	/** Get the current panel state. */
	getState(): VerificationPanelState;

	/** Render the verification report as HTML for the diff review webview. */
	renderReportHtml(report: VerificationReport): string;

	/** Render the progress indicator during verification. */
	renderProgressHtml(progress: VerificationProgress): string;

	/** Handle a suggestion button click. Returns the prompt to send to the agent. */
	handleSuggestionAction(suggestion: VerificationSuggestion): string;
}

// --- Service Implementation ---

export class NyrveVerificationPanel extends Disposable implements INyrveVerificationPanel {
	declare readonly _serviceBrand: undefined;

	private _state: VerificationPanelState = {
		report: undefined,
		isVerifying: false,
		currentStep: '',
		expanded: new Set(),
	};

	private readonly _listeners = this._register(new DisposableStore());

	constructor(
		@INyrveAgentService private readonly agentService: INyrveAgentService,
		@ILogService _logService: ILogService,
	) {
		super();

		// Listen for verification events
		this._listeners.add(this.agentService.onDidVerificationProgress(p => {
			this._state = { ...this._state, isVerifying: true, currentStep: p.message };
		}));

		this._listeners.add(this.agentService.onDidCompleteVerification(report => {
			this._state = { ...this._state, report, isVerifying: false, currentStep: '' };
		}));
	}

	getState(): VerificationPanelState {
		return this._state;
	}

	renderReportHtml(report: VerificationReport): string {
		const statusIcon = this._getStatusIcon(report.status);
		const confidenceColor = this._getConfidenceColor(report.confidence);

		const parts: string[] = [];

		// Header
		parts.push(`<div class="nyrve-verification-report">`);
		parts.push(`<div class="nyrve-vr-header">`);
		parts.push(`<span class="nyrve-vr-title">${localize('nyrve.verification.reportTitle', "Verification Report")}</span>`);
		if (report.totalAttempts > 0) {
			parts.push(`<span class="nyrve-vr-attempts">${localize('nyrve.verification.attempts', "Attempt {0}/{1}", report.totalAttempts, 3)}</span>`);
		}
		parts.push(`</div>`);

		// Check rows
		parts.push(`<div class="nyrve-vr-checks">`);

		// Type check
		parts.push(this._renderCheckRow(
			'type_check',
			this._getCheckIcon(report.typeCheck.status),
			localize('nyrve.verification.typeCheck', "Type check"),
			this._getTypeCheckSummary(report),
		));

		// Tests
		parts.push(this._renderCheckRow(
			'tests',
			this._getCheckIcon(report.tests.status),
			localize('nyrve.verification.tests', "Tests"),
			this._getTestSummary(report),
		));

		// Coverage
		parts.push(this._renderCheckRow(
			'coverage',
			this._getCheckIcon(report.coverage.status === 'warning' ? 'fail' : report.coverage.status),
			localize('nyrve.verification.coverage', "Coverage"),
			this._getCoverageSummary(report),
		));

		// Imports
		parts.push(this._renderCheckRow(
			'imports',
			this._getCheckIcon(report.imports.status),
			localize('nyrve.verification.imports', "Imports"),
			this._getImportSummary(report),
		));

		parts.push(`</div>`);

		// Self-heal history
		if (report.attempts.length > 0) {
			parts.push(`<div class="nyrve-vr-heal">`);
			parts.push(`<span class="nyrve-vr-heal-icon">\u{1F527}</span>`);
			parts.push(`<span>${localize('nyrve.verification.selfHealed', "Self-healed: Fixed {0} issue(s) on attempt {1}",
				report.attempts.reduce((sum, a) => sum + a.fixesApplied.length, 0),
				report.attempts.length
			)}</span>`);
			parts.push(`</div>`);
		}

		// Confidence + stats
		parts.push(`<div class="nyrve-vr-footer">`);
		parts.push(`<span class="nyrve-vr-confidence" style="color: ${confidenceColor}">${statusIcon} ${localize('nyrve.verification.confidence', "Confidence: {0}%", report.confidence)}</span>`);
		parts.push(`<span class="nyrve-vr-duration">${localize('nyrve.verification.duration', "Duration: {0}s", Math.round(report.duration / 1000))}</span>`);
		parts.push(`</div>`);

		// Suggestions
		if (report.suggestions.length > 0) {
			parts.push(`<div class="nyrve-vr-suggestions">`);
			for (const suggestion of report.suggestions) {
				parts.push(`<div class="nyrve-vr-suggestion">`);
				// allow-any-unicode-next-line
				parts.push(`<span>\u{1F4A1} ${suggestion.description}</span>`);
				parts.push(`<button class="nyrve-vr-suggestion-btn" data-action="${suggestion.type}">${suggestion.actionLabel}</button>`);
				parts.push(`</div>`);
			}
			parts.push(`</div>`);
		}

		parts.push(`</div>`);

		return parts.join('\n');
	}

	renderProgressHtml(progress: VerificationProgress): string {
		const icon = progress.status === 'running' ? '\u23F3'
			: progress.status === 'passed' ? '\u2705'
				: progress.status === 'failed' ? '\u274C'
					: '\u23ED';

		return `<div class="nyrve-vr-progress">${icon} ${progress.message}</div>`;
	}

	handleSuggestionAction(suggestion: VerificationSuggestion): string {
		return suggestion.actionPrompt;
	}

	// --- Private helpers ---

	private _renderCheckRow(id: string, icon: string, label: string, summary: string): string {
		return `<div class="nyrve-vr-check" data-check="${id}">` +
			`<span class="nyrve-vr-check-icon">${icon}</span>` +
			`<span class="nyrve-vr-check-label">${label}</span>` +
			`<span class="nyrve-vr-check-summary">${summary}</span>` +
			`</div>`;
	}

	private _getStatusIcon(status: string): string {
		switch (status) {
			case 'passed': return '\u2705';
			case 'passed_with_warnings': return '⚠️';
			case 'failed': return '\u274C';
			default: return '\u23ED';
		}
	}

	private _getCheckIcon(status: string): string {
		switch (status) {
			case 'pass': return '\u2705';
			case 'fail': return '\u274C';
			case 'skipped': return '\u23ED';
			case 'no_tests': return '\u23ED';
			default: return '\u2753';
		}
	}

	private _getConfidenceColor(confidence: number): string {
		if (confidence >= 80) {
			return '#4caf50';
		}
		if (confidence >= 60) {
			return '#ff9800';
		}
		return '#f44336';
	}

	private _getTypeCheckSummary(report: VerificationReport): string {
		if (report.typeCheck.status === 'skipped') {
			return localize('nyrve.verification.skipped', "Skipped");
		}
		const newCount = report.typeCheck.newErrors.length;
		const preExisting = report.typeCheck.errorsBefore.length;
		if (newCount === 0) {
			return localize('nyrve.verification.typeCheckPass', "0 new errors ({0} pre-existing)", preExisting);
		}
		return localize('nyrve.verification.typeCheckFail', "{0} new error(s)", newCount);
	}

	private _getTestSummary(report: VerificationReport): string {
		if (report.tests.status === 'skipped') {
			return localize('nyrve.verification.skipped', "Skipped");
		}
		if (report.tests.status === 'no_tests') {
			return localize('nyrve.verification.noTests', "No relevant tests found");
		}
		const r = report.tests.afterRun;
		const regCount = report.tests.regressions.length;
		return localize('nyrve.verification.testSummary', "{0} passed, {1} failed, {2} regression(s)",
			r.passed, r.failed, regCount);
	}

	private _getCoverageSummary(report: VerificationReport): string {
		if (report.coverage.status === 'skipped') {
			return localize('nyrve.verification.skipped', "Skipped");
		}
		return localize('nyrve.verification.coverageSummary', "{0}% of changed lines covered",
			report.coverage.overallCoveragePercent);
	}

	private _getImportSummary(report: VerificationReport): string {
		if (report.imports.status === 'skipped') {
			return localize('nyrve.verification.skipped', "Skipped");
		}
		if (report.imports.brokenImports.length === 0 && report.imports.newCircularDeps.length === 0) {
			return localize('nyrve.verification.importsPass', "All resolved, no circular deps");
		}
		return localize('nyrve.verification.importsFail', "{0} broken, {1} circular dep(s)",
			report.imports.brokenImports.length, report.imports.newCircularDeps.length);
	}
}

registerSingleton(INyrveVerificationPanel, NyrveVerificationPanel, InstantiationType.Delayed);
