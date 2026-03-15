/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Forge contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from '../../vs/base/common/event.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import { GitHubWorkflowRun, IForgeGitHubService } from './github-service.js';

// --- Types ---

export const enum CIStatus {
	Unknown = 'unknown',
	Running = 'running',
	Passed = 'passed',
	Failed = 'failed',
	Cancelled = 'cancelled',
}

export interface CIStatusUpdate {
	readonly status: CIStatus;
	readonly run: GitHubWorkflowRun | undefined;
	readonly branch: string;
}

// --- Service Interface ---

export const IForgeCIMonitor = createDecorator<IForgeCIMonitor>('forgeCIMonitor');

export interface IForgeCIMonitor {
	readonly _serviceBrand: undefined;

	readonly onDidChangeStatus: Event<CIStatusUpdate>;

	/** Get the current CI status for a branch. */
	readonly currentStatus: CIStatus;

	/** Start monitoring CI for a repo/branch. */
	startMonitoring(owner: string, repo: string, branch: string): void;

	/** Stop monitoring. */
	stopMonitoring(): void;

	/** Fetch failure logs for the most recent failed run. */
	fetchFailureLogs(owner: string, repo: string): Promise<string | undefined>;
}

// --- Service Implementation ---

export class ForgeCIMonitor extends Disposable implements IForgeCIMonitor {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeStatus = this._register(new Emitter<CIStatusUpdate>());
	readonly onDidChangeStatus: Event<CIStatusUpdate> = this._onDidChangeStatus.event;

	private _currentStatus: CIStatus = CIStatus.Unknown;
	private _pollTimer: ReturnType<typeof setInterval> | undefined;
	private _monitoredBranch: string | undefined;
	private _lastRun: GitHubWorkflowRun | undefined;
	private _monitoredOwner: string | undefined;
	private _monitoredRepo: string | undefined;

	get currentStatus(): CIStatus {
		return this._currentStatus;
	}

	constructor(
		@IForgeGitHubService private readonly githubService: IForgeGitHubService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	startMonitoring(owner: string, repo: string, branch: string): void {
		const ciEnabled = this.configurationService.getValue<boolean>('forge.github.ciMonitoring') ?? true;
		if (!ciEnabled) {
			return;
		}

		this.stopMonitoring();

		this._monitoredOwner = owner;
		this._monitoredRepo = repo;
		this._monitoredBranch = branch;

		// Poll every 30 seconds
		this._pollTimer = setInterval(() => this._poll(), 30000);

		// Immediate first check
		this._poll();

		this.logService.info(`[Forge] Started CI monitoring for ${owner}/${repo}@${branch}`);
	}

	stopMonitoring(): void {
		if (this._pollTimer) {
			clearInterval(this._pollTimer);
			this._pollTimer = undefined;
		}
		this._monitoredBranch = undefined;
	}

	async fetchFailureLogs(owner: string, repo: string): Promise<string | undefined> {
		if (!this._lastRun || this._lastRun.conclusion !== 'failure') {
			return undefined;
		}

		try {
			return await this.githubService.getWorkflowJobLogs(owner, repo, this._lastRun.id);
		} catch (e) {
			this.logService.warn(`[Forge] Failed to fetch CI logs: ${e}`);
			return undefined;
		}
	}

	private async _poll(): Promise<void> {
		if (!this._monitoredOwner || !this._monitoredRepo || !this._monitoredBranch) {
			return;
		}

		try {
			const runs = await this.githubService.getWorkflowRuns(this._monitoredOwner, this._monitoredRepo, this._monitoredBranch);
			if (runs.length === 0) {
				return;
			}

			const latestRun = runs[0];
			this._lastRun = latestRun;

			const newStatus = this._mapRunToStatus(latestRun);
			if (newStatus !== this._currentStatus) {
				this._currentStatus = newStatus;
				this._onDidChangeStatus.fire({
					status: newStatus,
					run: latestRun,
					branch: this._monitoredBranch,
				});
			}
		} catch (e) {
			this.logService.warn(`[Forge] CI polling error: ${e}`);
		}
	}

	private _mapRunToStatus(run: GitHubWorkflowRun): CIStatus {
		if (run.status === 'in_progress' || run.status === 'queued') {
			return CIStatus.Running;
		}
		switch (run.conclusion) {
			case 'success': return CIStatus.Passed;
			case 'failure': return CIStatus.Failed;
			case 'cancelled':
			case 'timed_out': return CIStatus.Cancelled;
			default: return CIStatus.Unknown;
		}
	}

	override dispose(): void {
		this.stopMonitoring();
		super.dispose();
	}
}

registerSingleton(IForgeCIMonitor, ForgeCIMonitor, InstantiationType.Delayed);
