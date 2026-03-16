/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Nyrve contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from '../../vs/base/common/event.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import { createDecorator } from '../../vs/platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../vs/platform/instantiation/common/extensions.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { ISecretStorageService } from '../../vs/platform/secrets/common/secrets.js';

// --- Constants ---

const GITHUB_TOKEN_KEY = 'nyrve.github.token';

// --- Service Interface ---

export const INyrveGitHubAuth = createDecorator<INyrveGitHubAuth>('nyrveGitHubAuth');

export interface INyrveGitHubAuth {
	readonly _serviceBrand: undefined;

	readonly onDidChangeAuthStatus: Event<boolean>;

	/** Check if authenticated. */
	isAuthenticated(): Promise<boolean>;

	/** Get the stored GitHub token. */
	getToken(): Promise<string | undefined>;

	/** Store a GitHub token (from OAuth flow or manual entry). */
	setToken(token: string): Promise<void>;

	/** Clear stored token (sign out). */
	clearToken(): Promise<void>;

	/** Get authenticated user info. */
	getAuthenticatedUser(): Promise<{ login: string; name: string | null } | undefined>;
}

// --- Service Implementation ---

export class NyrveGitHubAuth extends Disposable implements INyrveGitHubAuth {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeAuthStatus = this._register(new Emitter<boolean>());
	readonly onDidChangeAuthStatus: Event<boolean> = this._onDidChangeAuthStatus.event;

	constructor(
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async isAuthenticated(): Promise<boolean> {
		const token = await this.getToken();
		return !!token;
	}

	async getToken(): Promise<string | undefined> {
		try {
			return await this.secretStorageService.get(GITHUB_TOKEN_KEY) ?? undefined;
		} catch {
			return undefined;
		}
	}

	async setToken(token: string): Promise<void> {
		await this.secretStorageService.set(GITHUB_TOKEN_KEY, token);
		this._onDidChangeAuthStatus.fire(true);
		this.logService.info('[Nyrve] GitHub token stored');
	}

	async clearToken(): Promise<void> {
		await this.secretStorageService.delete(GITHUB_TOKEN_KEY);
		this._onDidChangeAuthStatus.fire(false);
		this.logService.info('[Nyrve] GitHub token cleared');
	}

	async getAuthenticatedUser(): Promise<{ login: string; name: string | null } | undefined> {
		const token = await this.getToken();
		if (!token) {
			return undefined;
		}

		try {
			const response = await fetch('https://api.github.com/user', {
				headers: {
					'Authorization': `Bearer ${token}`,
					'Accept': 'application/vnd.github.v3+json',
					'User-Agent': 'Nyrve-IDE',
				},
			});

			if (!response.ok) {
				this.logService.warn(`[Nyrve] GitHub auth check failed: ${response.status}`);
				return undefined;
			}

			const data = await response.json();
			return { login: data.login, name: data.name };
		} catch (e) {
			this.logService.warn(`[Nyrve] GitHub auth check error: ${e}`);
			return undefined;
		}
	}
}

registerSingleton(INyrveGitHubAuth, NyrveGitHubAuth, InstantiationType.Delayed);
