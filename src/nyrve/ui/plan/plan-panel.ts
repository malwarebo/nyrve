/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../vs/base/common/lifecycle.js';
import { Emitter, Event } from '../../../vs/base/common/event.js';
import { localize } from '../../../vs/nls.js';
import { createDecorator } from '../../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../../vs/platform/log/common/log.js';
import {
	Plan,
	PlanStatus,
	PlanStep,
	StepStatus,
	PlanRequest,
	PlanEstimate,
	INyrvePlanStorage,
} from '../../plan/plan-types.js';
import { INyrvePlanGenerator } from '../../plan/plan-generator.js';
import { INyrvePlanExecutor, } from '../../plan/plan-executor.js';

// --- Types ---

export type PlanPanelPhase = 'idle' | 'generating' | 'review' | 'executing' | 'completed';

export interface PlanPanelState {
	readonly phase: PlanPanelPhase;
	readonly plan: Plan | undefined;
	readonly estimate: PlanEstimate | undefined;
	readonly executingStepIndex: number;
	readonly error: string | undefined;
}

// --- Service Interface ---

export const INyrvePlanPanel = createDecorator<INyrvePlanPanel>('nyrvePlanPanel');

export interface INyrvePlanPanel {
	readonly _serviceBrand: undefined;

	/** Current panel state. */
	readonly state: PlanPanelState;

	/** Fires when state changes. */
	readonly onDidChangeState: Event<PlanPanelState>;

	/** Whether plan mode is active. */
	readonly isActive: boolean;

	/** Enter plan mode. */
	activate(): void;

	/** Exit plan mode. */
	deactivate(): void;

	/** Start plan generation from a user request. */
	startPlan(request: PlanRequest): Promise<void>;

	/** Revise the current plan with user feedback. */
	revisePlan(feedback: string): Promise<void>;

	/** Approve and execute the current plan. */
	executePlan(): Promise<void>;

	/** Pause execution. */
	pauseExecution(): void;

	/** Resume execution. */
	resumeExecution(): void;

	/** Cancel the plan. */
	cancelPlan(): void;

	/** Edit a step's user notes. */
	editStep(stepIndex: number, notes: string): void;

	/** Remove a step. */
	removeStep(stepIndex: number): void;

	/** Add a step at a position. */
	addStep(atIndex: number, title: string, description: string): void;

	/** Reorder steps. */
	moveStep(fromIndex: number, toIndex: number): void;

	/** Skip a step during execution. */
	skipStep(stepIndex: number): void;

	/** Retry a failed step. */
	retryStep(stepIndex: number): void;

	/** Get HTML for the panel webview. */
	getHtml(): string;
}

// --- Implementation ---

export class NyrvePlanPanelService extends Disposable implements INyrvePlanPanel {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<PlanPanelState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private _isActive = false;
	private _state: PlanPanelState = {
		phase: 'idle',
		plan: undefined,
		estimate: undefined,
		executingStepIndex: -1,
		error: undefined,
	};

	private readonly _executorListeners = this._register(new DisposableStore());

	get isActive(): boolean {
		return this._isActive;
	}

	get state(): PlanPanelState {
		return this._state;
	}

	constructor(
		@INyrvePlanGenerator private readonly planGenerator: INyrvePlanGenerator,
		@INyrvePlanExecutor private readonly planExecutor: INyrvePlanExecutor,
		@INyrvePlanStorage private readonly planStorage: INyrvePlanStorage,
		@ILogService _logService: ILogService,
	) {
		super();

		// Listen to executor events
		this._executorListeners.add(this.planExecutor.onStepStarted(e => {
			this._updateState({
				executingStepIndex: e.stepIndex,
			});
		}));

		this._executorListeners.add(this.planExecutor.onStepCompleted(e => {
			if (this._state.plan) {
				this._updateState({ plan: this._state.plan });
			}
		}));

		this._executorListeners.add(this.planExecutor.onPlanCompleted(result => {
			this._updateState({
				phase: result.status === 'completed' ? 'completed' : 'review',
				plan: result.plan,
			});
		}));

		this._executorListeners.add(this.planExecutor.onPlanFailed(e => {
			this._updateState({
				error: e.error,
			});
		}));
	}

	activate(): void {
		this._isActive = true;
		// Restore active plan if any
		const activePlan = this.planStorage.getActivePlan();
		if (activePlan) {
			const phase = this._planStatusToPhase(activePlan.status);
			this._updateState({ phase, plan: activePlan });
		} else {
			this._updateState({ phase: 'idle', plan: undefined });
		}
	}

	deactivate(): void {
		this._isActive = false;
		this._updateState({ phase: 'idle' });
	}

	async startPlan(request: PlanRequest): Promise<void> {
		this._updateState({ phase: 'generating', error: undefined });

		try {
			const plan = await this.planGenerator.generatePlan(request);
			const estimate = await this.planGenerator.estimatePlan(plan);

			this._updateState({
				phase: 'review',
				plan,
				estimate,
			});
		} catch (e) {
			const error = e instanceof Error ? e.message : String(e);
			this._updateState({
				phase: 'idle',
				error: `Plan generation failed: ${error}`,
			});
		}
	}

	async revisePlan(feedback: string): Promise<void> {
		if (!this._state.plan) {
			return;
		}

		this._updateState({ phase: 'generating' });

		try {
			const revised = await this.planGenerator.revisePlan(this._state.plan, feedback);
			const estimate = await this.planGenerator.estimatePlan(revised);

			this._updateState({
				phase: 'review',
				plan: revised,
				estimate,
			});
		} catch (e) {
			const error = e instanceof Error ? e.message : String(e);
			this._updateState({
				phase: 'review',
				error: `Plan revision failed: ${error}`,
			});
		}
	}

	async executePlan(): Promise<void> {
		if (!this._state.plan) {
			return;
		}

		this._state.plan.status = PlanStatus.Approved;
		this._updateState({ phase: 'executing', executingStepIndex: 0, error: undefined });

		try {
			await this.planExecutor.execute(this._state.plan);
		} catch (e) {
			const error = e instanceof Error ? e.message : String(e);
			this._updateState({ error });
		}
	}

	pauseExecution(): void {
		this.planExecutor.pause();
	}

	resumeExecution(): void {
		this.planExecutor.resume();
		this._updateState({ phase: 'executing' });
	}

	cancelPlan(): void {
		if (this.planExecutor.isExecuting) {
			this.planExecutor.cancel();
		}
		this.planStorage.clearActivePlan();
		this._updateState({
			phase: 'idle',
			plan: undefined,
			estimate: undefined,
			executingStepIndex: -1,
			error: undefined,
		});
	}

	editStep(stepIndex: number, notes: string): void {
		if (!this._state.plan || stepIndex >= this._state.plan.steps.length) {
			return;
		}
		this._state.plan.steps[stepIndex].userNotes = notes;
		this._state.plan.steps[stepIndex].userModified = true;
		this._state.plan.updatedAt = new Date().toISOString();
		this._updateState({ plan: this._state.plan });
	}

	removeStep(stepIndex: number): void {
		if (!this._state.plan || stepIndex >= this._state.plan.steps.length) {
			return;
		}
		const removedId = this._state.plan.steps[stepIndex].id;
		this._state.plan.steps.splice(stepIndex, 1);
		// Reindex remaining steps
		for (let i = 0; i < this._state.plan.steps.length; i++) {
			(this._state.plan.steps[i] as { index: number }).index = i;
		}
		// Remove dependencies on the removed step
		for (const step of this._state.plan.steps) {
			const depIdx = step.dependsOn.indexOf(removedId);
			if (depIdx >= 0) {
				(step.dependsOn as string[]).splice(depIdx, 1);
			}
		}
		this._state.plan.updatedAt = new Date().toISOString();
		this._updateState({ plan: this._state.plan });
	}

	addStep(atIndex: number, title: string, description: string): void {
		if (!this._state.plan) {
			return;
		}
		const newStep: PlanStep = {
			id: `step_custom_${Date.now()}`,
			index: atIndex,
			title,
			description,
			actions: [],
			dependsOn: [],
			status: StepStatus.Pending,
			userModified: true,
			userNotes: '',
		};
		this._state.plan.steps.splice(atIndex, 0, newStep);
		// Reindex
		for (let i = 0; i < this._state.plan.steps.length; i++) {
			(this._state.plan.steps[i] as { index: number }).index = i;
		}
		this._state.plan.updatedAt = new Date().toISOString();
		this._updateState({ plan: this._state.plan });
	}

	moveStep(fromIndex: number, toIndex: number): void {
		if (!this._state.plan) {
			return;
		}
		const steps = this._state.plan.steps;
		if (fromIndex < 0 || fromIndex >= steps.length || toIndex < 0 || toIndex >= steps.length) {
			return;
		}
		const [step] = steps.splice(fromIndex, 1);
		steps.splice(toIndex, 0, step);
		// Reindex
		for (let i = 0; i < steps.length; i++) {
			(steps[i] as { index: number }).index = i;
		}
		this._state.plan.updatedAt = new Date().toISOString();
		this._updateState({ plan: this._state.plan });
	}

	skipStep(stepIndex: number): void {
		this.planExecutor.skipStep(stepIndex);
	}

	retryStep(stepIndex: number): void {
		this.planExecutor.retryStep(stepIndex);
	}

	getHtml(): string {
		return this._renderPanel();
	}

	private _updateState(partial: Partial<PlanPanelState>): void {
		this._state = { ...this._state, ...partial };
		this._onDidChangeState.fire(this._state);
	}

	private _planStatusToPhase(status: PlanStatus): PlanPanelPhase {
		switch (status) {
			case PlanStatus.Generating:
			case PlanStatus.Revision:
				return 'generating';
			case PlanStatus.Review:
			case PlanStatus.Approved:
				return 'review';
			case PlanStatus.Executing:
			case PlanStatus.Paused:
				return 'executing';
			case PlanStatus.Completed:
				return 'completed';
			default:
				return 'idle';
		}
	}

	private _renderPanel(): string {
		const { phase, plan, estimate, error } = this._state;

		let content: string;
		switch (phase) {
			case 'idle':
				content = this._renderIdle();
				break;
			case 'generating':
				content = this._renderGenerating();
				break;
			case 'review':
				content = this._renderReview(plan!, estimate);
				break;
			case 'executing':
				content = this._renderExecuting(plan!);
				break;
			case 'completed':
				content = this._renderCompleted(plan!);
				break;
			default:
				content = this._renderIdle();
		}

		if (error) {
			content += `<div class="plan-error">${this._escapeHtml(error)}</div>`;
		}

		return `<!DOCTYPE html>
<html>
<head>
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px; margin: 0; }
.plan-header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 8px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 12px; }
.plan-title { font-size: 14px; font-weight: 600; }
.plan-meta { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 12px; }
.step { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px 12px; margin-bottom: 8px; }
.step-title { font-weight: 600; font-size: 13px; }
.step-desc { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
.step-status { display: inline-block; width: 16px; text-align: center; margin-right: 8px; }
.step.completed { border-left: 3px solid var(--vscode-testing-iconPassed); }
.step.executing { border-left: 3px solid var(--vscode-progressBar-background); }
.step.failed { border-left: 3px solid var(--vscode-testing-iconFailed); }
.step.pending { opacity: 0.7; }
.actions-bar { display: flex; gap: 8px; margin-top: 12px; }
.btn { padding: 6px 12px; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
.btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.plan-error { padding: 8px 12px; margin-top: 8px; background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); border-radius: 4px; font-size: 12px; }
.generating { text-align: center; padding: 24px; }
.spinner { display: inline-block; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.idle-input { width: 100%; padding: 8px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 4px; font-size: 13px; box-sizing: border-box; }
</style>
</head>
<body>
${content}
</body>
</html>`;
	}

	private _renderIdle(): string {
		return `
<div class="plan-header">
	<span class="plan-title">${localize('nyrve.plan.title', "Plan Mode")}</span>
</div>
<p style="font-size: 12px; color: var(--vscode-descriptionForeground);">
	${localize('nyrve.plan.idleMessage', "Describe a complex task and the agent will create a step-by-step plan before writing code.")}
</p>
<textarea class="idle-input" rows="4" placeholder="${localize('nyrve.plan.placeholder', "e.g., Add authentication with JWT and refresh tokens...")}" id="planInput"></textarea>
<div class="actions-bar">
	<button class="btn btn-primary" onclick="submitPlan()">${localize('nyrve.plan.generate', "Generate Plan")}</button>
</div>`;
	}

	private _renderGenerating(): string {
		return `
<div class="plan-header">
	<span class="plan-title">${localize('nyrve.plan.generating', "Generating Plan...")}</span>
</div>
<div class="generating">
	<div class="spinner">&#x23F3;</div>
	<p>${localize('nyrve.plan.analyzingCodebase', "Analyzing codebase and creating plan...")}</p>
</div>`;
	}

	private _renderReview(plan: Plan, estimate: PlanEstimate | undefined): string {
		let metaText = `${plan.steps.length} steps`;
		if (estimate) {
			metaText += ` \u00b7 ${estimate.estimatedTime} \u00b7 ~${estimate.estimatedTokens.toLocaleString()} tokens (~$${estimate.estimatedCost.toFixed(2)})`;
		}

		let stepsHtml = '';
		for (const step of plan.steps) {
			const actionsText = step.actions
				.map(a => a.filePath ? `${a.type}: ${a.filePath}` : a.description)
				.join(', ');
			stepsHtml += `
<div class="step">
	<div class="step-title">${step.index + 1}. ${this._escapeHtml(step.title)}</div>
	<div class="step-desc">${this._escapeHtml(step.description)}</div>
	${actionsText ? `<div class="step-desc" style="margin-top: 2px; font-style: italic;">${this._escapeHtml(actionsText)}</div>` : ''}
</div>`;
		}

		return `
<div class="plan-header">
	<span class="plan-title">${this._escapeHtml(plan.title)}</span>
</div>
<div class="plan-meta">${metaText}</div>
${stepsHtml}
<div class="actions-bar">
	<button class="btn btn-secondary" onclick="revisePlan()">${localize('nyrve.plan.revise', "Revise Plan")}</button>
	<button class="btn btn-secondary" onclick="cancelPlan()">${localize('nyrve.plan.cancel', "Cancel")}</button>
	<button class="btn btn-primary" onclick="executePlan()">${localize('nyrve.plan.execute', "Execute Plan")}</button>
</div>`;
	}

	private _renderExecuting(plan: Plan): string {
		let stepsHtml = '';
		for (const step of plan.steps) {
			const statusIcon = this._getStepIcon(step.status);
			const statusClass = step.status === StepStatus.Completed ? 'completed' :
				step.status === StepStatus.Executing || step.status === StepStatus.Verifying ? 'executing' :
					step.status === StepStatus.Failed ? 'failed' : 'pending';

			const result = plan.executionResults.find(r => r.stepId === step.id);
			const duration = result ? ` ${(result.duration / 1000).toFixed(1)}s` : '';

			stepsHtml += `
<div class="step ${statusClass}">
	<span class="step-status">${statusIcon}</span>
	<span class="step-title">${step.index + 1}. ${this._escapeHtml(step.title)}</span>
	<span style="float: right; font-size: 11px; color: var(--vscode-descriptionForeground);">${duration}</span>
</div>`;
		}

		return `
<div class="plan-header">
	<span class="plan-title">${this._escapeHtml(plan.title)}</span>
	<div>
		<button class="btn btn-secondary" onclick="pauseExecution()">${localize('nyrve.plan.pause', "Pause")}</button>
		<button class="btn btn-secondary" onclick="cancelPlan()">${localize('nyrve.plan.stop', "Stop")}</button>
	</div>
</div>
${stepsHtml}`;
	}

	private _renderCompleted(plan: Plan): string {
		const results = plan.executionResults;
		const succeeded = results.filter(r => r.status === 'success').length;
		const failed = results.filter(r => r.status === 'failed').length;
		const skipped = results.filter(r => r.status === 'skipped').length;
		const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);
		const totalTokens = results.reduce((sum, r) => sum + r.tokensUsed, 0);

		return `
<div class="plan-header">
	<span class="plan-title">${localize('nyrve.plan.completed', "Plan Completed")}</span>
</div>
<div class="plan-meta">
	${this._escapeHtml(plan.title)}<br>
	${succeeded} succeeded \u00b7 ${failed} failed \u00b7 ${skipped} skipped<br>
	${(totalDuration / 1000).toFixed(1)}s total \u00b7 ${totalTokens.toLocaleString()} tokens
</div>
<div class="actions-bar">
	<button class="btn btn-secondary" onclick="cancelPlan()">${localize('nyrve.plan.close', "Close")}</button>
</div>`;
	}

	private _getStepIcon(status: StepStatus): string {
		switch (status) {
			case StepStatus.Completed: return '\u2705';
			case StepStatus.Executing: return '\u25B6';
			case StepStatus.Verifying: return '\u{1F50D}';
			case StepStatus.Failed: return '\u274C';
			case StepStatus.Skipped: return '\u23ED';
			case StepStatus.Pending: return '\u25CB';
			default: return '\u25CB';
		}
	}

	private _escapeHtml(str: string): string {
		return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}
}

registerSingleton(INyrvePlanPanel, NyrvePlanPanelService, InstantiationType.Delayed);
