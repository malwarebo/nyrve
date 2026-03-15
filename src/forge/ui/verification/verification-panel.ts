/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../vs/nls.js';
import { Disposable, DisposableStore } from '../../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../../vs/platform/log/common/log.js';
import { IForgeAgentService } from '../../agent/agent-service.js';
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

export const IForgeVerificationPanel = createDecorator<IForgeVerificationPanel>('forgeVerificationPanel');

export interface IForgeVerificationPanel {
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

export class ForgeVerificationPanel extends Disposable implements IForgeVerificationPanel {
	declare readonly _serviceBrand: undefined;

	private _state: VerificationPanelState = {
		report: undefined,
		isVerifying: false,
		currentStep: '',
		expanded: new Set(),
	};

	private readonly _listeners = this._register(new DisposableStore());

	constructor(
		@IForgeAgentService private readonly agentService: IForgeAgentService,
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
		parts.push(`<div class="forge-verification-report">`);
		parts.push(`<div class="forge-vr-header">`);
		parts.push(`<span class="forge-vr-title">${localize('forge.verification.reportTitle', "Verification Report")}</span>`);
		if (report.totalAttempts > 0) {
			parts.push(`<span class="forge-vr-attempts">${localize('forge.verification.attempts', "Attempt {0}/{1}", report.totalAttempts, 3)}</span>`);
		}
		parts.push(`</div>`);

		// Check rows
		parts.push(`<div class="forge-vr-checks">`);

		// Type check
		parts.push(this._renderCheckRow(
			'type_check',
			this._getCheckIcon(report.typeCheck.status),
			localize('forge.verification.typeCheck', "Type check"),
			this._getTypeCheckSummary(report),
		));

		// Tests
		parts.push(this._renderCheckRow(
			'tests',
			this._getCheckIcon(report.tests.status),
			localize('forge.verification.tests', "Tests"),
			this._getTestSummary(report),
		));

		// Coverage
		parts.push(this._renderCheckRow(
			'coverage',
			this._getCheckIcon(report.coverage.status === 'warning' ? 'fail' : report.coverage.status),
			localize('forge.verification.coverage', "Coverage"),
			this._getCoverageSummary(report),
		));

		// Imports
		parts.push(this._renderCheckRow(
			'imports',
			this._getCheckIcon(report.imports.status),
			localize('forge.verification.imports', "Imports"),
			this._getImportSummary(report),
		));

		parts.push(`</div>`);

		// Self-heal history
		if (report.attempts.length > 0) {
			parts.push(`<div class="forge-vr-heal">`);
			parts.push(`<span class="forge-vr-heal-icon">🔧</span>`);
			parts.push(`<span>${localize('forge.verification.selfHealed', "Self-healed: Fixed {0} issue(s) on attempt {1}",
				report.attempts.reduce((sum, a) => sum + a.fixesApplied.length, 0),
				report.attempts.length
			)}</span>`);
			parts.push(`</div>`);
		}

		// Confidence + stats
		parts.push(`<div class="forge-vr-footer">`);
		parts.push(`<span class="forge-vr-confidence" style="color: ${confidenceColor}">${statusIcon} ${localize('forge.verification.confidence', "Confidence: {0}%", report.confidence)}</span>`);
		parts.push(`<span class="forge-vr-duration">${localize('forge.verification.duration', "Duration: {0}s", Math.round(report.duration / 1000))}</span>`);
		parts.push(`</div>`);

		// Suggestions
		if (report.suggestions.length > 0) {
			parts.push(`<div class="forge-vr-suggestions">`);
			for (const suggestion of report.suggestions) {
				parts.push(`<div class="forge-vr-suggestion">`);
				parts.push(`<span>💡 ${suggestion.description}</span>`);
				parts.push(`<button class="forge-vr-suggestion-btn" data-action="${suggestion.type}">${suggestion.actionLabel}</button>`);
				parts.push(`</div>`);
			}
			parts.push(`</div>`);
		}

		parts.push(`</div>`);

		return parts.join('\n');
	}

	renderProgressHtml(progress: VerificationProgress): string {
		const icon = progress.status === 'running' ? '⏳'
			: progress.status === 'passed' ? '✅'
				: progress.status === 'failed' ? '❌'
					: '⏭';

		return `<div class="forge-vr-progress">${icon} ${progress.message}</div>`;
	}

	handleSuggestionAction(suggestion: VerificationSuggestion): string {
		return suggestion.actionPrompt;
	}

	// --- Private helpers ---

	private _renderCheckRow(id: string, icon: string, label: string, summary: string): string {
		return `<div class="forge-vr-check" data-check="${id}">` +
			`<span class="forge-vr-check-icon">${icon}</span>` +
			`<span class="forge-vr-check-label">${label}</span>` +
			`<span class="forge-vr-check-summary">${summary}</span>` +
			`</div>`;
	}

	private _getStatusIcon(status: string): string {
		switch (status) {
			case 'passed': return '✅';
			case 'passed_with_warnings': return '⚠️';
			case 'failed': return '❌';
			default: return '⏭';
		}
	}

	private _getCheckIcon(status: string): string {
		switch (status) {
			case 'pass': return '✅';
			case 'fail': return '❌';
			case 'skipped': return '⏭';
			case 'no_tests': return '⏭';
			default: return '❓';
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
			return localize('forge.verification.skipped', "Skipped");
		}
		const newCount = report.typeCheck.newErrors.length;
		const preExisting = report.typeCheck.errorsBefore.length;
		if (newCount === 0) {
			return localize('forge.verification.typeCheckPass', "0 new errors ({0} pre-existing)", preExisting);
		}
		return localize('forge.verification.typeCheckFail', "{0} new error(s)", newCount);
	}

	private _getTestSummary(report: VerificationReport): string {
		if (report.tests.status === 'skipped') {
			return localize('forge.verification.skipped', "Skipped");
		}
		if (report.tests.status === 'no_tests') {
			return localize('forge.verification.noTests', "No relevant tests found");
		}
		const r = report.tests.afterRun;
		const regCount = report.tests.regressions.length;
		return localize('forge.verification.testSummary', "{0} passed, {1} failed, {2} regression(s)",
			r.passed, r.failed, regCount);
	}

	private _getCoverageSummary(report: VerificationReport): string {
		if (report.coverage.status === 'skipped') {
			return localize('forge.verification.skipped', "Skipped");
		}
		return localize('forge.verification.coverageSummary', "{0}% of changed lines covered",
			report.coverage.overallCoveragePercent);
	}

	private _getImportSummary(report: VerificationReport): string {
		if (report.imports.status === 'skipped') {
			return localize('forge.verification.skipped', "Skipped");
		}
		if (report.imports.brokenImports.length === 0 && report.imports.newCircularDeps.length === 0) {
			return localize('forge.verification.importsPass', "All resolved, no circular deps");
		}
		return localize('forge.verification.importsFail', "{0} broken, {1} circular dep(s)",
			report.imports.brokenImports.length, report.imports.newCircularDeps.length);
	}
}

registerSingleton(IForgeVerificationPanel, ForgeVerificationPanel, InstantiationType.Delayed);
