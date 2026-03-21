/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { Emitter, Event } from '../../vs/base/common/event.js';
import { CancellationTokenSource } from '../../vs/base/common/cancellation.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { IFileService } from '../../vs/platform/files/common/files.js';
import { IWorkspaceContextService } from '../../vs/platform/workspace/common/workspace.js';
import { URI } from '../../vs/base/common/uri.js';
import { INyrveAgentEngine, NyrveAgentRequest } from '../agent/agent-engine.js';
import { INyrveVerificationEngine } from '../agent/verification-engine.js';
import { INyrveTokenTracker } from '../agent/token-tracker.js';
import { NyrveChangeSet, NyrveFileChange, ChangeSetStatus, HunkStatus } from '../ui/diff-review/diff-panel.js';
import {
	Plan,
	PlanStep,
	PlanStatus,
	StepStatus,
	StepExecutionResult,
	PlanExecutionResult,
	INyrvePlanStorage,
} from './plan-types.js';

// --- Service Interface ---

export const INyrvePlanExecutor = createDecorator<INyrvePlanExecutor>('nyrvePlanExecutor');

export interface INyrvePlanExecutor {
	readonly _serviceBrand: undefined;

	/** Execute an approved plan. */
	execute(plan: Plan): Promise<PlanExecutionResult>;

	/** Execute a single step. */
	executeStep(plan: Plan, stepIndex: number): Promise<StepExecutionResult>;

	/** Pause execution. */
	pause(): void;

	/** Resume execution. */
	resume(): void;

	/** Cancel execution. */
	cancel(): void;

	/** Skip a step. */
	skipStep(stepIndex: number): void;

	/** Retry a failed step. */
	retryStep(stepIndex: number): void;

	/** Whether execution is currently active. */
	readonly isExecuting: boolean;

	// Events
	readonly onStepStarted: Event<{ stepIndex: number; step: PlanStep }>;
	readonly onStepCompleted: Event<{ stepIndex: number; result: StepExecutionResult }>;
	readonly onPlanCompleted: Event<PlanExecutionResult>;
	readonly onPlanFailed: Event<{ stepIndex: number; error: string }>;
}

// --- Implementation ---

export class NyrvePlanExecutor extends Disposable implements INyrvePlanExecutor {
	declare readonly _serviceBrand: undefined;

	private readonly _onStepStarted = this._register(new Emitter<{ stepIndex: number; step: PlanStep }>());
	readonly onStepStarted = this._onStepStarted.event;

	private readonly _onStepCompleted = this._register(new Emitter<{ stepIndex: number; result: StepExecutionResult }>());
	readonly onStepCompleted = this._onStepCompleted.event;

	private readonly _onPlanCompleted = this._register(new Emitter<PlanExecutionResult>());
	readonly onPlanCompleted = this._onPlanCompleted.event;

	private readonly _onPlanFailed = this._register(new Emitter<{ stepIndex: number; error: string }>());
	readonly onPlanFailed = this._onPlanFailed.event;

	private _isExecuting = false;
	private _isPaused = false;
	private _isCancelled = false;
	private _stepsToSkip = new Set<number>();
	private _stepsToRetry = new Set<number>();

	get isExecuting(): boolean {
		return this._isExecuting;
	}

	constructor(
		@INyrveAgentEngine private readonly agentEngine: INyrveAgentEngine,
		@INyrveVerificationEngine private readonly verificationEngine: INyrveVerificationEngine,
		@INyrveTokenTracker private readonly tokenTracker: INyrveTokenTracker,
		@INyrvePlanStorage private readonly planStorage: INyrvePlanStorage,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IConfigurationService _configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async execute(plan: Plan): Promise<PlanExecutionResult> {
		if (this._isExecuting) {
			throw new Error('Plan execution already in progress');
		}

		this._isExecuting = true;
		this._isPaused = false;
		this._isCancelled = false;
		this._stepsToSkip.clear();
		this._stepsToRetry.clear();

		plan.status = PlanStatus.Executing;
		plan.updatedAt = new Date().toISOString();
		this.planStorage.setActivePlan(plan);

		const startTime = Date.now();
		let totalTokens = 0;
		let stepsCompleted = 0;

		try {
			for (let i = plan.currentStepIndex; i < plan.steps.length; i++) {
				// Check cancellation
				if (this._isCancelled) {
					plan.status = PlanStatus.Cancelled;
					break;
				}

				// Wait while paused
				while (this._isPaused && !this._isCancelled) {
					plan.status = PlanStatus.Paused;
					this.planStorage.setActivePlan(plan);
					await this._sleep(500);
				}

				if (this._isCancelled) {
					plan.status = PlanStatus.Cancelled;
					break;
				}

				// Check if step should be skipped
				if (this._stepsToSkip.has(i)) {
					const skipResult: StepExecutionResult = {
						stepId: plan.steps[i].id,
						status: 'skipped',
						changesetId: null,
						verificationPassed: true,
						duration: 0,
						tokensUsed: 0,
					};
					plan.steps[i].status = StepStatus.Skipped;
					plan.executionResults.push(skipResult);
					this._onStepCompleted.fire({ stepIndex: i, result: skipResult });
					stepsCompleted++;
					continue;
				}

				plan.status = PlanStatus.Executing;
				plan.currentStepIndex = i;
				this.planStorage.setActivePlan(plan);

				// Execute the step
				const result = await this.executeStep(plan, i);
				plan.executionResults.push(result);
				totalTokens += result.tokensUsed;

				if (result.status === 'success') {
					stepsCompleted++;
				} else if (result.status === 'failed') {
					// Check if we should retry
					if (this._stepsToRetry.has(i)) {
						this._stepsToRetry.delete(i);
						i--; // Retry this step
						plan.executionResults.pop(); // Remove the failed result
						continue;
					}

					// Step failed — pause and notify
					this._isPaused = true;
					plan.status = PlanStatus.Paused;
					this.planStorage.setActivePlan(plan);
					this._onPlanFailed.fire({ stepIndex: i, error: result.error ?? 'Step execution failed' });

					// Wait for user action (resume, skip, cancel)
					while (this._isPaused && !this._isCancelled) {
						await this._sleep(500);
					}

					if (this._isCancelled) {
						plan.status = PlanStatus.Cancelled;
						break;
					}

					// Check if user wants to skip or retry
					if (this._stepsToSkip.has(i)) {
						stepsCompleted++;
						continue;
					}
					if (this._stepsToRetry.has(i)) {
						this._stepsToRetry.delete(i);
						i--;
						plan.executionResults.pop();
						continue;
					}
				}
			}
		} catch (e) {
			this.logService.error('[Nyrve] Plan execution error', e);
			plan.status = PlanStatus.Failed;
		} finally {
			this._isExecuting = false;
		}

		if (plan.status === PlanStatus.Executing) {
			plan.status = PlanStatus.Completed;
		}

		plan.updatedAt = new Date().toISOString();
		this.planStorage.setActivePlan(plan);
		await this.planStorage.save(plan);

		const totalCost = this.tokenTracker.getTodaySummary().totalCostUsd;

		const executionResult: PlanExecutionResult = {
			plan,
			status: plan.status === PlanStatus.Completed ? 'completed' :
				plan.status === PlanStatus.Cancelled ? 'cancelled' :
					plan.status === PlanStatus.Failed ? 'failed' : 'partial',
			stepsCompleted,
			stepsTotal: plan.steps.length,
			totalDuration: Date.now() - startTime,
			totalTokens,
			totalCost,
		};

		this._onPlanCompleted.fire(executionResult);
		this.logService.info(`[Nyrve] Plan execution finished: ${executionResult.status} (${stepsCompleted}/${plan.steps.length} steps)`);

		return executionResult;
	}

	async executeStep(plan: Plan, stepIndex: number): Promise<StepExecutionResult> {
		const step = plan.steps[stepIndex];
		if (!step) {
			throw new Error(`Invalid step index: ${stepIndex}`);
		}

		this.logService.info(`[Nyrve] Executing step ${stepIndex + 1}/${plan.steps.length}: ${step.title}`);
		this._onStepStarted.fire({ stepIndex, step });

		step.status = StepStatus.Executing;
		this.planStorage.setActivePlan(plan);

		const startTime = Date.now();

		try {
			const stepPrompt = this._buildStepPrompt(plan, step, stepIndex);

			const cts = new CancellationTokenSource();
			const agentRequest: NyrveAgentRequest = {
				messages: [{ role: 'user', content: stepPrompt, timestamp: Date.now() }],
				systemPrompt: this._buildStepSystemPrompt(stepIndex),
			};
			const response = await this.agentEngine.sendMessage(agentRequest, cts.token);
			cts.dispose();

			const tokensUsed = response ? (response.inputTokens + response.outputTokens) : 0;

			// Parse file changes from the agent response
			const changeset = await this._parseResponseToChangeset(response.content, step);

			let verificationPassed = true;
			let changesetId: string | null = null;

			if (changeset && changeset.files.length > 0) {
				changesetId = changeset.id;
				step.status = StepStatus.Verifying;
				this.planStorage.setActivePlan(plan);

				// Run verification pipeline
				const report = await this.verificationEngine.verify(changeset);
				verificationPassed = report.status === 'passed' || report.status === 'passed_with_warnings';

				this.logService.info(
					`[Nyrve] Step ${stepIndex + 1} verification: ${report.status} ` +
					`(confidence: ${report.confidence}%)`
				);
			}

			const duration = Date.now() - startTime;
			step.status = verificationPassed ? StepStatus.Completed : StepStatus.Failed;

			const result: StepExecutionResult = {
				stepId: step.id,
				status: verificationPassed ? 'success' : 'failed',
				changesetId,
				verificationPassed,
				duration,
				tokensUsed,
				error: verificationPassed ? undefined : 'Verification failed after self-heal attempts',
			};

			this._onStepCompleted.fire({ stepIndex, result });
			return result;
		} catch (e) {
			step.status = StepStatus.Failed;
			const errorMsg = e instanceof Error ? e.message : String(e);

			const result: StepExecutionResult = {
				stepId: step.id,
				status: 'failed',
				changesetId: null,
				verificationPassed: false,
				duration: Date.now() - startTime,
				tokensUsed: 0,
				error: errorMsg,
			};

			this._onStepCompleted.fire({ stepIndex, result });
			return result;
		}
	}

	pause(): void {
		this._isPaused = true;
	}

	resume(): void {
		this._isPaused = false;
	}

	cancel(): void {
		this._isCancelled = true;
		this._isPaused = false;
	}

	skipStep(stepIndex: number): void {
		this._stepsToSkip.add(stepIndex);
		// If paused on this step, resume
		if (this._isPaused) {
			this._isPaused = false;
		}
	}

	retryStep(stepIndex: number): void {
		this._stepsToRetry.add(stepIndex);
		if (this._isPaused) {
			this._isPaused = false;
		}
	}

	private _buildStepSystemPrompt(stepIndex: number): string {
		return [
			`You are executing step ${stepIndex + 1} of a plan. Follow the instructions precisely.`,
			'Only modify files within the scope of this step.',
			'Output each file change as:',
			'### FILE: <path>',
			'```',
			'<full file content>',
			'```',
		].join('\n');
	}

	/**
	 * Parse the agent's response to extract file changes and build a NyrveChangeSet.
	 */
	private async _parseResponseToChangeset(
		response: string,
		step: PlanStep,
	): Promise<NyrveChangeSet | undefined> {
		const filePattern = /### FILE:\s*(.+?)\n```(?:\w*)\n([\s\S]*?)```/g;
		const files: NyrveFileChange[] = [];
		let match: RegExpExecArray | null;

		const root = this._getWorkspaceRoot();
		if (!root) {
			return undefined;
		}

		while ((match = filePattern.exec(response)) !== null) {
			const filePath = match[1].trim();
			const proposedContent = match[2];

			// Read original content from disk
			let originalContent = '';
			try {
				const uri = URI.joinPath(root, filePath);
				const existing = await this.fileService.readFile(uri);
				originalContent = existing.value.toString();
			} catch {
				// New file — original is empty
			}

			if (originalContent === proposedContent) {
				continue;
			}

			files.push({
				filePath,
				originalContent,
				proposedContent,
				hunks: [{
					id: `hunk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
					filePath,
					startLine: 1,
					endLine: proposedContent.split('\n').length,
					originalContent,
					proposedContent,
					status: HunkStatus.Pending,
				}],
			});
		}

		if (files.length === 0) {
			return undefined;
		}

		return {
			id: `cs_${step.id}_${Date.now()}`,
			description: `Plan step: ${step.title}`,
			files,
			status: ChangeSetStatus.Proposed,
			createdAt: Date.now(),
		};
	}

	private _getWorkspaceRoot(): URI | undefined {
		const folders = this.workspaceContextService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri : undefined;
	}

	private _buildStepPrompt(plan: Plan, step: PlanStep, stepIndex: number): string {
		const parts: string[] = [];

		parts.push(`Execute step ${stepIndex + 1} of the plan: "${step.title}"`);
		parts.push('');
		parts.push(step.description);
		parts.push('');

		// Actions
		if (step.actions.length > 0) {
			parts.push('Actions:');
			for (const action of step.actions) {
				if (action.filePath) {
					parts.push(`- ${action.type}: ${action.filePath} — ${action.description}`);
				} else if (action.command) {
					parts.push(`- ${action.type}: ${action.command} — ${action.description}`);
				} else {
					parts.push(`- ${action.type}: ${action.description}`);
				}
			}
			parts.push('');
		}

		// User notes
		if (step.userNotes) {
			parts.push(`User notes: ${step.userNotes}`);
			parts.push('');
		}

		// Previous step summaries
		const completedSteps = plan.executionResults.filter(r => r.status === 'success');
		if (completedSteps.length > 0) {
			parts.push('Previous steps completed:');
			for (const result of completedSteps) {
				const completedStep = plan.steps.find(s => s.id === result.stepId);
				if (completedStep) {
					parts.push(`- ✓ ${completedStep.title}`);
				}
			}
			parts.push('');
		}

		parts.push('Do NOT modify files outside the scope of this step.');

		return parts.join('\n');
	}

	private _sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}

registerSingleton(INyrvePlanExecutor, NyrvePlanExecutor, InstantiationType.Delayed);
