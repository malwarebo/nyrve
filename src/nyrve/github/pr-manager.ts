/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from '../../vs/base/common/event.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { GitHubPullRequest, INyrveGitHubService } from './github-service.js';

// --- Types ---

export interface PRCreateParams {
	readonly owner: string;
	readonly repo: string;
	readonly title: string;
	readonly description: string;
	readonly branchName: string;
	readonly baseBranch: string;
	readonly draft?: boolean;
	readonly labels?: string[];
}

// --- Service Interface ---

export const INyrvePRManager = createDecorator<INyrvePRManager>('nyrvePRManager');

export interface INyrvePRManager {
	readonly _serviceBrand: undefined;

	readonly onDidCreatePR: Event<GitHubPullRequest>;

	/** Create a PR from the given params. */
	createPR(params: PRCreateParams): Promise<GitHubPullRequest>;

	/** Generate a branch name from a task description. */
	generateBranchName(description: string): string;

	/** Generate a PR description from a diff summary and conversation. */
	generatePRDescription(summary: string, changedFiles: readonly string[]): string;

	/** Get recently created PRs in this session. */
	getSessionPRs(): readonly GitHubPullRequest[];
}

// --- Service Implementation ---

export class NyrvePRManager extends Disposable implements INyrvePRManager {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidCreatePR = this._register(new Emitter<GitHubPullRequest>());
	readonly onDidCreatePR: Event<GitHubPullRequest> = this._onDidCreatePR.event;

	private readonly _sessionPRs: GitHubPullRequest[] = [];

	constructor(
		@INyrveGitHubService private readonly githubService: INyrveGitHubService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async createPR(params: PRCreateParams): Promise<GitHubPullRequest> {
		const pr = await this.githubService.createPullRequest(params.owner, params.repo, {
			title: params.title,
			body: params.description,
			head: params.branchName,
			base: params.baseBranch,
			draft: params.draft,
		});

		this._sessionPRs.push(pr);
		this._onDidCreatePR.fire(pr);
		this.logService.info(`[Nyrve] Created PR #${pr.number}: ${pr.title}`);

		return pr;
	}

	generateBranchName(description: string): string {
		const slug = description
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, '')
			.replace(/\s+/g, '-')
			.slice(0, 50)
			.replace(/-$/, '');

		return `nyrve/${slug}`;
	}

	generatePRDescription(summary: string, changedFiles: readonly string[]): string {
		const fileList = changedFiles.map(f => `- \`${f}\``).join('\n');

		return [
			'## Summary',
			summary,
			'',
			'## Changes',
			fileList,
			'',
			'## Testing',
			'[Describe testing performed]',
			'',
			'---',
			'*This PR was created with [Nyrve IDE](https://nyrve.dev) assistance.*',
		].join('\n');
	}

	getSessionPRs(): readonly GitHubPullRequest[] {
		return this._sessionPRs;
	}
}

registerSingleton(INyrvePRManager, NyrvePRManager, InstantiationType.Delayed);
