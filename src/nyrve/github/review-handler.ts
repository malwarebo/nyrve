/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from '../../vs/base/common/event.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { INyrveGitHubService } from './github-service.js';

// --- Types ---

export interface ReviewComment {
	readonly id: number;
	readonly body: string;
	readonly path: string;
	readonly line: number | null;
	readonly user: string;
	readonly createdAt: string;
	readonly url: string;
}

// --- Service Interface ---

export const INyrveReviewHandler = createDecorator<INyrveReviewHandler>('nyrveReviewHandler');

export interface INyrveReviewHandler {
	readonly _serviceBrand: undefined;

	readonly onDidReceiveComment: Event<ReviewComment>;

	/** Fetch review comments for a PR. */
	fetchComments(owner: string, repo: string, prNumber: number): Promise<readonly ReviewComment[]>;

	/** Post a reply comment on a PR. */
	postReply(owner: string, repo: string, prNumber: number, body: string, inReplyTo?: number): Promise<void>;

	/** Start polling for new comments on a PR. */
	startPolling(owner: string, repo: string, prNumber: number, intervalMs?: number): void;

	/** Stop polling. */
	stopPolling(): void;
}

// --- Service Implementation ---

export class NyrveReviewHandler extends Disposable implements INyrveReviewHandler {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidReceiveComment = this._register(new Emitter<ReviewComment>());
	readonly onDidReceiveComment: Event<ReviewComment> = this._onDidReceiveComment.event;

	private _pollTimer: ReturnType<typeof setInterval> | undefined;
	private _knownCommentIds = new Set<number>();

	constructor(
		@INyrveGitHubService private readonly githubService: INyrveGitHubService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async fetchComments(owner: string, repo: string, prNumber: number): Promise<readonly ReviewComment[]> {
		const data = await this.githubService.apiRequest<Array<{
			id: number; body: string; path: string; line: number | null;
			user: { login: string }; created_at: string; html_url: string;
		}>>('GET', `/repos/${owner}/${repo}/pulls/${prNumber}/comments`);

		return data.map(c => ({
			id: c.id,
			body: c.body,
			path: c.path,
			line: c.line,
			user: c.user.login,
			createdAt: c.created_at,
			url: c.html_url,
		}));
	}

	async postReply(owner: string, repo: string, prNumber: number, body: string, inReplyTo?: number): Promise<void> {
		if (inReplyTo) {
			await this.githubService.apiRequest('POST', `/repos/${owner}/${repo}/pulls/${prNumber}/comments`, {
				body,
				in_reply_to: inReplyTo,
			});
		} else {
			await this.githubService.apiRequest('POST', `/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
				body,
			});
		}

		this.logService.info(`[Nyrve] Posted review reply on PR #${prNumber}`);
	}

	startPolling(owner: string, repo: string, prNumber: number, intervalMs: number = 60000): void {
		this.stopPolling();

		this._pollTimer = setInterval(async () => {
			try {
				const comments = await this.fetchComments(owner, repo, prNumber);
				for (const comment of comments) {
					if (!this._knownCommentIds.has(comment.id)) {
						this._knownCommentIds.add(comment.id);
						this._onDidReceiveComment.fire(comment);
					}
				}
			} catch (e) {
				this.logService.warn(`[Nyrve] Comment polling error: ${e}`);
			}
		}, intervalMs);

		this.logService.trace(`[Nyrve] Started polling comments for PR #${prNumber}`);
	}

	stopPolling(): void {
		if (this._pollTimer) {
			clearInterval(this._pollTimer);
			this._pollTimer = undefined;
		}
	}

	override dispose(): void {
		this.stopPolling();
		super.dispose();
	}
}

registerSingleton(INyrveReviewHandler, NyrveReviewHandler, InstantiationType.Delayed);
