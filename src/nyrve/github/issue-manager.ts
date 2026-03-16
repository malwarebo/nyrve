/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from '../../vs/base/common/event.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { GitHubIssue, INyrveGitHubService } from './github-service.js';

// --- Service Interface ---

export const INyrveIssueManager = createDecorator<INyrveIssueManager>('nyrveIssueManager');

export interface INyrveIssueManager {
	readonly _serviceBrand: undefined;

	readonly onDidRefreshIssues: Event<readonly GitHubIssue[]>;

	/** Fetch open issues for a repo. */
	fetchIssues(owner: string, repo: string): Promise<readonly GitHubIssue[]>;

	/** Get a specific issue with full details. */
	getIssue(owner: string, repo: string, number: number): Promise<GitHubIssue>;

	/** Parse issue references (#123) from text. */
	parseIssueReferences(text: string): readonly number[];

	/** Get cached issues. */
	getCachedIssues(): readonly GitHubIssue[];
}

// --- Service Implementation ---

const ISSUE_REF_REGEX = /#(\d+)/g;

export class NyrveIssueManager extends Disposable implements INyrveIssueManager {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidRefreshIssues = this._register(new Emitter<readonly GitHubIssue[]>());
	readonly onDidRefreshIssues: Event<readonly GitHubIssue[]> = this._onDidRefreshIssues.event;

	private _cachedIssues: GitHubIssue[] = [];

	constructor(
		@INyrveGitHubService private readonly githubService: INyrveGitHubService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async fetchIssues(owner: string, repo: string): Promise<readonly GitHubIssue[]> {
		const issues = await this.githubService.listIssues(owner, repo, 'open');
		this._cachedIssues = issues;
		this._onDidRefreshIssues.fire(issues);
		this.logService.trace(`[Nyrve] Fetched ${issues.length} issues from ${owner}/${repo}`);
		return issues;
	}

	async getIssue(owner: string, repo: string, number: number): Promise<GitHubIssue> {
		return this.githubService.getIssue(owner, repo, number);
	}

	parseIssueReferences(text: string): readonly number[] {
		const numbers: number[] = [];
		let match: RegExpExecArray | null;
		const regex = new RegExp(ISSUE_REF_REGEX.source, ISSUE_REF_REGEX.flags);
		while ((match = regex.exec(text)) !== null) {
			numbers.push(parseInt(match[1], 10));
		}
		return [...new Set(numbers)];
	}

	getCachedIssues(): readonly GitHubIssue[] {
		return this._cachedIssues;
	}
}

registerSingleton(INyrveIssueManager, NyrveIssueManager, InstantiationType.Delayed);
