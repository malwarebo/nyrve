/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { INyrveGitHubAuth } from './auth.js';

// --- Types ---

export interface GitHubRepo {
	readonly owner: string;
	readonly name: string;
	readonly fullName: string;
	readonly defaultBranch: string;
}

export interface GitHubIssue {
	readonly number: number;
	readonly title: string;
	readonly body: string | null;
	readonly state: 'open' | 'closed';
	readonly labels: readonly string[];
	readonly assignee: string | null;
	readonly createdAt: string;
	readonly url: string;
}

export interface GitHubPullRequest {
	readonly number: number;
	readonly title: string;
	readonly body: string | null;
	readonly state: 'open' | 'closed' | 'merged';
	readonly head: { readonly ref: string; readonly sha: string };
	readonly base: { readonly ref: string };
	readonly url: string;
	readonly htmlUrl: string;
	readonly draft: boolean;
}

export interface GitHubWorkflowRun {
	readonly id: number;
	readonly name: string;
	readonly status: 'queued' | 'in_progress' | 'completed';
	readonly conclusion: 'success' | 'failure' | 'cancelled' | 'timed_out' | null;
	readonly htmlUrl: string;
}

// --- Service Interface ---

export const INyrveGitHubService = createDecorator<INyrveGitHubService>('nyrveGitHubService');

export interface INyrveGitHubService {
	readonly _serviceBrand: undefined;

	/** Make an authenticated GitHub API request. */
	apiRequest<T>(method: string, path: string, body?: unknown): Promise<T>;

	/** Get repository info. */
	getRepo(owner: string, repo: string): Promise<GitHubRepo>;

	/** List issues for a repo. */
	listIssues(owner: string, repo: string, state?: 'open' | 'closed' | 'all'): Promise<GitHubIssue[]>;

	/** Get a single issue. */
	getIssue(owner: string, repo: string, number: number): Promise<GitHubIssue>;

	/** Create a pull request. */
	createPullRequest(owner: string, repo: string, params: {
		title: string;
		body: string;
		head: string;
		base: string;
		draft?: boolean;
	}): Promise<GitHubPullRequest>;

	/** Get workflow runs for a repo. */
	getWorkflowRuns(owner: string, repo: string, branch?: string): Promise<GitHubWorkflowRun[]>;

	/** Get workflow job logs. */
	getWorkflowJobLogs(owner: string, repo: string, runId: number): Promise<string>;
}

// --- Service Implementation ---

export class NyrveGitHubService extends Disposable implements INyrveGitHubService {
	declare readonly _serviceBrand: undefined;

	private readonly _apiBase = 'https://api.github.com';

	constructor(
		@INyrveGitHubAuth private readonly auth: INyrveGitHubAuth,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async apiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
		const token = await this.auth.getToken();
		if (!token) {
			throw new Error('Not authenticated with GitHub');
		}

		const url = path.startsWith('http') ? path : `${this._apiBase}${path}`;
		const headers: Record<string, string> = {
			'Authorization': `Bearer ${token}`,
			'Accept': 'application/vnd.github.v3+json',
			'User-Agent': 'Nyrve-IDE',
		};

		if (body) {
			headers['Content-Type'] = 'application/json';
		}

		const response = await fetch(url, {
			method,
			headers,
			body: body ? JSON.stringify(body) : undefined,
		});

		if (!response.ok) {
			const errorBody = await response.text();
			this.logService.warn(`[Nyrve] GitHub API error ${response.status}: ${errorBody}`);
			throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
		}

		return response.json() as Promise<T>;
	}

	async getRepo(owner: string, repo: string): Promise<GitHubRepo> {
		const data = await this.apiRequest<{ owner: { login: string }; name: string; full_name: string; default_branch: string }>('GET', `/repos/${owner}/${repo}`);
		return {
			owner: data.owner.login,
			name: data.name,
			fullName: data.full_name,
			defaultBranch: data.default_branch,
		};
	}

	async listIssues(owner: string, repo: string, state: 'open' | 'closed' | 'all' = 'open'): Promise<GitHubIssue[]> {
		const data = await this.apiRequest<Array<{
			number: number; title: string; body: string | null; state: string;
			labels: Array<{ name: string }>; assignee: { login: string } | null;
			created_at: string; html_url: string;
		}>>('GET', `/repos/${owner}/${repo}/issues?state=${state}&per_page=30`);

		return data.map(issue => ({
			number: issue.number,
			title: issue.title,
			body: issue.body,
			state: issue.state as 'open' | 'closed',
			labels: issue.labels.map(l => l.name),
			assignee: issue.assignee?.login ?? null,
			createdAt: issue.created_at,
			url: issue.html_url,
		}));
	}

	async getIssue(owner: string, repo: string, number: number): Promise<GitHubIssue> {
		const issue = await this.apiRequest<{
			number: number; title: string; body: string | null; state: string;
			labels: Array<{ name: string }>; assignee: { login: string } | null;
			created_at: string; html_url: string;
		}>('GET', `/repos/${owner}/${repo}/issues/${number}`);

		return {
			number: issue.number,
			title: issue.title,
			body: issue.body,
			state: issue.state as 'open' | 'closed',
			labels: issue.labels.map(l => l.name),
			assignee: issue.assignee?.login ?? null,
			createdAt: issue.created_at,
			url: issue.html_url,
		};
	}

	async createPullRequest(owner: string, repo: string, params: {
		title: string; body: string; head: string; base: string; draft?: boolean;
	}): Promise<GitHubPullRequest> {
		const data = await this.apiRequest<{
			number: number; title: string; body: string | null; state: string;
			head: { ref: string; sha: string }; base: { ref: string };
			url: string; html_url: string; draft: boolean;
		}>('POST', `/repos/${owner}/${repo}/pulls`, params);

		return {
			number: data.number,
			title: data.title,
			body: data.body,
			state: data.state as 'open' | 'closed' | 'merged',
			head: data.head,
			base: data.base,
			url: data.url,
			htmlUrl: data.html_url,
			draft: data.draft,
		};
	}

	async getWorkflowRuns(owner: string, repo: string, branch?: string): Promise<GitHubWorkflowRun[]> {
		const branchParam = branch ? `&branch=${encodeURIComponent(branch)}` : '';
		const data = await this.apiRequest<{ workflow_runs: Array<{
			id: number; name: string; status: string; conclusion: string | null; html_url: string;
		}> }>('GET', `/repos/${owner}/${repo}/actions/runs?per_page=10${branchParam}`);

		return data.workflow_runs.map(run => ({
			id: run.id,
			name: run.name,
			status: run.status as GitHubWorkflowRun['status'],
			conclusion: run.conclusion as GitHubWorkflowRun['conclusion'],
			htmlUrl: run.html_url,
		}));
	}

	async getWorkflowJobLogs(owner: string, repo: string, runId: number): Promise<string> {
		const token = await this.auth.getToken();
		if (!token) {
			throw new Error('Not authenticated with GitHub');
		}

		const response = await fetch(`${this._apiBase}/repos/${owner}/${repo}/actions/runs/${runId}/logs`, {
			headers: {
				'Authorization': `Bearer ${token}`,
				'User-Agent': 'Nyrve-IDE',
			},
		});

		if (!response.ok) {
			throw new Error(`Failed to fetch workflow logs: ${response.status}`);
		}

		return response.text();
	}
}

registerSingleton(INyrveGitHubService, NyrveGitHubService, InstantiationType.Delayed);
