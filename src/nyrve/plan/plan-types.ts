/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { Emitter, Event } from '../../vs/base/common/event.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { URI } from '../../vs/base/common/uri.js';
import { IFileService } from '../../vs/platform/files/common/files.js';
import { IWorkspaceContextService } from '../../vs/platform/workspace/common/workspace.js';
import { VSBuffer } from '../../vs/base/common/buffer.js';

// --- Plan Data Structures ---

export const enum PlanStatus {
	Generating = 'generating',
	Review = 'review',
	Revision = 'revision',
	Approved = 'approved',
	Executing = 'executing',
	Paused = 'paused',
	Completed = 'completed',
	Failed = 'failed',
	Cancelled = 'cancelled',
}

export const enum StepStatus {
	Pending = 'pending',
	Executing = 'executing',
	Verifying = 'verifying',
	Completed = 'completed',
	Failed = 'failed',
	Skipped = 'skipped',
}

export interface PlannedAction {
	readonly type: 'create_file' | 'modify_file' | 'delete_file' | 'run_command' | 'install_package';
	readonly filePath?: string;
	readonly description: string;
	readonly command?: string;
	readonly estimatedLinesChanged?: number;
}

export interface PlanStep {
	readonly id: string;
	readonly index: number;
	readonly title: string;
	readonly description: string;
	readonly actions: PlannedAction[];
	readonly dependsOn: string[];
	status: StepStatus;
	userModified: boolean;
	userNotes: string;
}

export interface StepExecutionResult {
	readonly stepId: string;
	readonly status: 'success' | 'failed' | 'skipped';
	readonly changesetId: string | null;
	readonly verificationPassed: boolean;
	readonly duration: number;
	readonly tokensUsed: number;
	readonly error?: string;
}

export interface Plan {
	readonly id: string;
	title: string;
	description: string;
	readonly userRequest: string;
	steps: PlanStep[];
	status: PlanStatus;
	currentStepIndex: number;
	readonly filesAnalyzed: string[];
	readonly memoryUsed: string[];
	readonly createdAt: string;
	updatedAt: string;
	estimatedTokens: number;
	estimatedTime: string;
	executionResults: StepExecutionResult[];
}

export interface PlanRequest {
	readonly userMessage: string;
	readonly activeFile?: string;
	readonly selectedCode?: string;
	readonly mentionedFiles?: string[];
}

export interface PlanEstimate {
	readonly estimatedTokens: number;
	readonly estimatedCost: number;
	readonly estimatedTime: string;
	readonly estimatedSteps: number;
	readonly complexity: 'simple' | 'moderate' | 'complex';
}

export interface PlanExecutionResult {
	readonly plan: Plan;
	readonly status: 'completed' | 'failed' | 'cancelled' | 'partial';
	readonly stepsCompleted: number;
	readonly stepsTotal: number;
	readonly totalDuration: number;
	readonly totalTokens: number;
	readonly totalCost: number;
}

// --- Plan Storage Service ---

export const INyrvePlanStorage = createDecorator<INyrvePlanStorage>('nyrvePlanStorage');

export interface INyrvePlanStorage {
	readonly _serviceBrand: undefined;

	/** Event: plan was created or updated. */
	readonly onDidChangePlan: Event<Plan>;

	/** Get the currently active plan. */
	getActivePlan(): Plan | undefined;

	/** Set the active plan. */
	setActivePlan(plan: Plan): void;

	/** Save a plan to persistent storage. */
	save(plan: Plan): Promise<void>;

	/** Load a plan by id. */
	load(planId: string): Promise<Plan | undefined>;

	/** List all saved plans (metadata only). */
	listPlans(): Promise<PlanSummary[]>;

	/** Delete a plan. */
	deletePlan(planId: string): Promise<void>;

	/** Clear the active plan. */
	clearActivePlan(): void;
}

export interface PlanSummary {
	readonly id: string;
	readonly title: string;
	readonly status: PlanStatus;
	readonly stepsCount: number;
	readonly createdAt: string;
	readonly updatedAt: string;
}

// --- Implementation ---

export class NyrvePlanStorage extends Disposable implements INyrvePlanStorage {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangePlan = this._register(new Emitter<Plan>());
	readonly onDidChangePlan = this._onDidChangePlan.event;

	private _activePlan: Plan | undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	getActivePlan(): Plan | undefined {
		return this._activePlan;
	}

	setActivePlan(plan: Plan): void {
		this._activePlan = plan;
		this._onDidChangePlan.fire(plan);
	}

	clearActivePlan(): void {
		this._activePlan = undefined;
	}

	async save(plan: Plan): Promise<void> {
		const uri = this._planUri(plan.id);
		const content = JSON.stringify(plan, null, 2);

		try {
			await this.fileService.writeFile(uri, VSBuffer.fromString(content));
			this.logService.trace(`[Nyrve] Plan saved: ${plan.id}`);
		} catch (e) {
			this.logService.error(`[Nyrve] Failed to save plan: ${plan.id}`, e);
		}
	}

	async load(planId: string): Promise<Plan | undefined> {
		const uri = this._planUri(planId);

		try {
			const content = await this.fileService.readFile(uri);
			return JSON.parse(content.value.toString()) as Plan;
		} catch {
			return undefined;
		}
	}

	async listPlans(): Promise<PlanSummary[]> {
		const dirUri = this._plansDir();
		const summaries: PlanSummary[] = [];

		try {
			const stat = await this.fileService.resolve(dirUri);
			if (stat.children) {
				for (const child of stat.children) {
					if (child.name.endsWith('.json')) {
						try {
							const content = await this.fileService.readFile(child.resource);
							const plan = JSON.parse(content.value.toString()) as Plan;
							summaries.push({
								id: plan.id,
								title: plan.title,
								status: plan.status,
								stepsCount: plan.steps.length,
								createdAt: plan.createdAt,
								updatedAt: plan.updatedAt,
							});
						} catch {
							// Skip corrupt plan files
						}
					}
				}
			}
		} catch {
			// Plans directory doesn't exist yet
		}

		return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async deletePlan(planId: string): Promise<void> {
		const uri = this._planUri(planId);
		try {
			await this.fileService.del(uri);
		} catch {
			// File may not exist
		}
	}

	private _planUri(planId: string): URI {
		const workspaceFolder = this.workspaceContextService.getWorkspace().folders[0];
		if (!workspaceFolder) {
			return URI.file(`.nyrve/plans/${planId}.json`);
		}
		return URI.joinPath(workspaceFolder.uri, '.nyrve', 'plans', `${planId}.json`);
	}

	private _plansDir(): URI {
		const workspaceFolder = this.workspaceContextService.getWorkspace().folders[0];
		if (!workspaceFolder) {
			return URI.file('.nyrve/plans');
		}
		return URI.joinPath(workspaceFolder.uri, '.nyrve', 'plans');
	}
}

registerSingleton(INyrvePlanStorage, NyrvePlanStorage, InstantiationType.Delayed);
